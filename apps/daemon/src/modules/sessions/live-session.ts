import {
  GetStateData,
  type InitRecord,
  PapError,
  type PiEvent,
  type ReadyRecord,
  type SessionStatus,
  type SessionStreamEvent,
  type WorkerRecord,
} from "@pap/contracts";
import { describeExit } from "../../kernel/supervisor/exit.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { createCoalescer } from "./coalescer.ts";
import type { LiveSession, LiveSessionDeps } from "./live-types.ts";
import { slimEntryRef, summaryRow } from "./entry-events.ts";
import { createLiveCommands } from "./live-commands.ts";
import { createLiveRun, isSystemMessage } from "./live-run.ts";
import { createLiveUi } from "./live-ui.ts";
import { createNoticeRing } from "./notices.ts";
import { createPartialReply } from "./partial.ts";
import { createQueueGuard, isClearedAnswer, readCleared } from "./queue-guard.ts";
import { clipMessage, clipPiEvent } from "./wire-clip.ts";
import { clip, outputTailOf } from "./worker-text.ts";

const GET_STATE_TIMEOUT_MS = 2000;
/** Fork to `ready` takes about 0.7 s (S1): a worker that has not said so after this is stuck, not slow. */
export const READY_TIMEOUT_MS = 30_000;
/** The socket allows 1 MiB per frame; an event is sent whole or not at all. */
const MAX_EVENT_BYTES = 1_000_000;
/** The user and the log hear of a thing the daemon keeps doing (cancelling a dialog, dropping an event) this often. */
const SAY_EVERY_MS = 10_000;
/** The client contract carries ids up to this long; a longer one counts as unknown (M2R52). */
const MAX_ID_CHARS = 128;
const knownId = (id: unknown): string | null =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS ? id : null;

export type { LiveSession, LiveSessionDeps } from "./live-types.ts";

export function startLiveSession(deps: LiveSessionDeps, init: InitRecord): LiveSession {
  const { handle, logger } = deps;
  let status: SessionStatus = "starting";
  let rss: number | null = null;
  let piFile: string | undefined;
  let piSessionId: string | undefined;
  let leafId: string | null = null;
  const limiter = createRateLimiter(deps.clock, SAY_EVERY_MS);
  const partial = createPartialReply();
  const notices = createNoticeRing();
  // Every notice is kept for the snapshot, whoever says it (M2R85).
  const emit = (event: SessionStreamEvent): void => {
    if (event.kind === "notice") {
      notices.add({
        level: event.level,
        text: event.text,
        ...(event.source ? { source: event.source } : {}),
      });
    }
    deps.publish(event);
  };
  // Every event this session publishes sends the pending deltas first, so text never arrives after what follows it.
  const publish = (event: SessionStreamEvent): void => {
    coalescer.flush();
    emit(event);
  };
  const coalescer = createCoalescer({
    clock: deps.clock,
    emit: (event) => {
      // Only the content is gated: a lifecycle event (a message's end) too large to stream still ends the partial reply.
      if (publishMeasured(event) || event.type !== "message_update") partial.apply(event);
    },
  });
  const setStatus = (next: SessionStatus, cause?: string) => {
    status = next;
    publish({ kind: "status", status: next, ...(cause ? { cause } : {}) });
  };
  const getState = async (): Promise<GetStateData> => {
    const response = await handle.request({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
    const parsed = GetStateData.safeParse(response.data);
    if (!response.success || !parsed.success) throw new PapError("worker_failed");
    return parsed.data;
  };

  // An event is sent whole or not at all, and every kind of event is measured: a `text_end` carries the whole text of
  // a block and a `toolcall_end` the whole call, so a delta is the only small one and it costs nothing to look.
  /** The stream's own frame for a Pi event, whole or not at all; false when it was too large and left out. */
  function publishMeasured(event: PiEvent): boolean {
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
      const said = limiter.check("event_too_large");
      if (said.allowed) {
        logger.warn("pi_event_too_large", { type: clip(event.type), suppressed: said.suppressed });
        emit({ kind: "notice", level: "warning", text: "A message was too large to stream." });
      }
      return false;
    }
    deps.publish({ kind: "pi", event });
    return true;
  }

  const queue = createQueueGuard();
  const ui = createLiveUi({ handle, clock: deps.clock, logger, limiter, publish });
  const commands = createLiveCommands({ handle, logger });
  const run = createLiveRun({
    handle,
    clock: deps.clock,
    logger,
    setStatus,
    record: deps.record,
    onActivity: deps.onActivity,
    piFile: () => piFile,
    leafId: () => leafId,
    getState,
    queue,
    promptBlocked: () => commands.activity().compacting || commands.structuralInFlight() > 0,
  });

  const ready = new Promise<ReadyRecord>((resolve, reject) => {
    const timer = deps.clock.setTimeout(() => {
      off();
      logger.warn("worker_not_ready", { output: outputTailOf(handle) });
      void handle.stop();
      reject(new PapError("worker_failed"));
    }, READY_TIMEOUT_MS);
    const off = handle.onRecord((record) => {
      if (record.type !== "ready") return;
      off();
      deps.clock.clearTimeout(timer);
      piFile = record.sessionFile;
      piSessionId = record.sessionId;
      leafId = knownId(record.leafId);
      setStatus("idle");
      resolve(record);
    });
    void handle.exited.then(() => {
      deps.clock.clearTimeout(timer);
      reject(new PapError("worker_failed"));
    });
  });
  // Whoever starts a session awaits this; one that is torn down meanwhile must not leave an unhandled rejection.
  ready.catch(() => undefined);

  // The worker sends an entry Pi appended as the slim record `toWireEvent` defines. It becomes an `entry` event (the
  // client binds the id to the message it already has); a compaction or a branch summary has no message event, so it
  // is also a `row`. Pi's own event is never forwarded.
  function onEntry(raw: unknown): void {
    const entry = slimEntryRef(raw);
    if (!entry) {
      logger.debug("entry_ignored");
      return;
    }
    leafId = entry.id;
    // Pi's system prompt is an entry like any other; the client never shows it, so it never hears of it (R107).
    if (entry.type === "message" && entry.role === "system") return;
    run.bindEntry(entry);
    publish({ kind: "entry", entry });
    const message = summaryRow(raw);
    if (message) {
      const row = { entryId: entry.id, message: clipMessage(message) };
      run.addRow(row);
      publish({ kind: "row", row });
    }
  }

  function onRecord(record: WorkerRecord): void {
    switch (record.type) {
      case "extension_ui_request":
        ui.onUiRequest(record);
        return;
      case "approval_request":
        ui.onApprovalRequest(record);
        return;
      case "approval_request_invalid":
        ui.onApprovalInvalid(record);
        return;
      case "extension_ui_closed":
        ui.onUiClosed(record.id);
        return;
      case "custom_render":
        ui.onPanelRender(record.id, record.lines);
        return;
      case "custom_close":
        ui.onPanelClose(record.id);
        return;
      case "audit":
        deps.record("policy", record.entry);
        return;
      case "health":
        rss = record.rssMb;
        return;
      case "extension_error":
        ui.onExtensionError(record);
        return;
      case "leaf": {
        leafId = knownId(record.leafId);
        // More entries are new than the worker sends at once: the rows of the run keep no id until the file is read.
        if (record.resync) {
          const said = limiter.check("entries_resync");
          if (said.allowed) logger.warn("entries_resync_needed", { suppressed: said.suppressed });
        }
        return;
      }
      case "pi_event": {
        const event = record.event;
        // The raw event is never forwarded: the stream carries the guard's bounded view of it.
        if (event.type === "queue_update") {
          publish({ kind: "queue", queue: queue.onQueueUpdate(event as never) });
          deps.onActivity();
          return;
        }
        if (event.type === "entry_appended") {
          onEntry(event.entry);
          deps.onActivity();
          return;
        }
        // Pi's system prompt travels as a message. It stays here: it is internal and may carry the user's AGENTS.md (R107).
        if (isSystemMessage(event)) {
          run.onPiEvent(event);
        } else {
          // Clipped before the run view and the coalescer see it: the snapshot and the stream hold the same rows.
          const clipped = clipPiEvent(event);
          run.onPiEvent(clipped ?? event);
          if (clipped) coalescer.push(clipped);
          const activity = commands.onPiEvent(event);
          if (activity) publish(activity);
        }
        deps.onActivity();
        return;
      }
      case "ready":
      case "response":
        return;
    }
  }
  handle.onRecord(onRecord);

  void handle.exited.then((exit) => {
    coalescer.flush();
    partial.reset();
    coalescer.dispose();
    queue.reset();
    commands.reset();
    const wasRunning = run.onExit();
    for (const dialog of ui.clear()) publish({ kind: "dialog_closed", id: dialog.id });
    for (const id of ui.clearDecorations()) publish({ kind: "panel_closed", id });
    if (wasRunning) deps.record("run_end", { interrupted: exit.cause });
    deps.record("worker_exit", exit);
    if (exit.cause === "clean") logger.info("worker_exited", { ...exit });
    else logger.warn("worker_exited", { ...exit, output: outputTailOf(handle) });
    setStatus("cold", describeExit(exit));
    deps.onActivity();
    deps.onExit(exit);
    deps.onWorkerExit?.({ exit, outputTail: handle.outputTail() });
  });
  if (!handle.send(init)) logger.warn("worker_init_not_sent");

  return {
    ready,
    status: () => status,
    rssMb: () => rss,
    pid: () => handle.pid,
    piFile: () => piFile,
    piSessionId: () => piSessionId,
    dialogs: () => ui.dialogs(),
    statuses: () => ui.statuses(),
    widgets: () => ui.widgets(),
    title: () => ui.title(),
    panels: () => ui.panels(),
    notices: () => notices.list(),
    panelInput: (id, data) => ui.panelInput(id, data),
    partial: () => partial.current(),
    leafId: () => leafId,
    runView: () => run.runView(),
    prompt: (text, streamingBehavior) => run.prompt(text, streamingBehavior),
    abort: () => run.abort(),
    busy: () =>
      run.tracker.running ||
      run.promptPending() ||
      commands.activity().compacting ||
      commands.structuralInFlight() > 0,
    command: (input) => commands.command(input),
    commandsInFlight: () => commands.inFlight(),
    navigated(next) {
      leafId = knownId(next);
    },
    activity: () => commands.activity(),
    queue: queue.view,
    async clearQueue() {
      const response = await handle.request({ type: "clear_queue" });
      if (!response.success) {
        logger.info("clear_queue_failed", { error: clip(response.error ?? "") });
        throw new PapError("worker_failed");
      }
      if (!isClearedAnswer(response.data)) {
        logger.warn("clear_queue_unreadable", { detail: clip(JSON.stringify(response.data) ?? "") });
      }
      return readCleared(response.data);
    },
    answer: (dialogId, response) => ui.answer(dialogId, response),
    send: (record) => handle.send(record),
    stop: async () => {
      ui.cancelPanels();
      await handle.stop();
    },
  };
}
