import {
  GetStateData,
  type InitRecord,
  PapError,
  type PiEvent,
  POLICY_EXTENSION_PATH,
  type ReadyRecord,
  SERVER_CODES,
  type ServerText,
  type SessionStatus,
  type SessionStreamEvent,
  type WorkerRecord,
} from "@pap/contracts";
import { describeExit } from "../../kernel/supervisor/exit.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { MAX_ID_CHARS } from "../../kernel/text.ts";
import { createCoalescer } from "./coalescer.ts";
import type { LiveSession, LiveSessionDeps } from "./live-types.ts";
import { slimEntryRef, summaryRow } from "./entry-events.ts";
import type { IdleState } from "./idle-release.ts";
import { createLiveCommands } from "./live-commands.ts";
import { createLiveIdle } from "./live-idle.ts";
import { createLiveRun, isSystemMessage } from "./live-run.ts";
import { createLiveUi } from "./live-ui.ts";
import { createLoadoutView } from "./loadout-view.ts";
import { nameOf } from "./names.ts";
import { createNoticeRing } from "./notices.ts";
import { createPartialReply } from "./partial.ts";
import { clearWorkerQueue, createQueueGuard } from "./queue-guard.ts";
import { clipMessage, clipPiEvent } from "./wire-clip.ts";
import { clip, outputTailOf } from "./worker-text.ts";

const GET_STATE_TIMEOUT_MS = 2000;
/** Fork to `ready` takes about 0.7 s (S1): a worker that has not said so after this is stuck, not slow. */
export const READY_TIMEOUT_MS = 30_000;
/** The socket allows 1 MiB per frame; an event is sent whole or not at all. */
const MAX_EVENT_BYTES = 1_000_000;
/** The user and the log hear of a thing the daemon keeps doing (cancelling a dialog, dropping an event) this often. */
const SAY_EVERY_MS = 10_000;
const knownId = (id: unknown): string | null =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS ? id : null;

export type { LiveSession, LiveSessionDeps } from "./live-types.ts";

export function startLiveSession(deps: LiveSessionDeps, init: InitRecord): LiveSession {
  const { handle, logger, onCardShown } = deps;
  let status: SessionStatus = "starting";
  let rss: number | null = null;
  let reportedFile: string | undefined;
  // A VM worker reports a path inside its VM: the session's file is its mirror on the host (R23), null until it is open.
  const piFile = (): string | undefined => (handle.piFile ? (handle.piFile() ?? undefined) : reportedFile);
  let piSessionId: string | undefined;
  let leafId: string | null = null;
  let name: string | null = null;
  // From the worker's `health`: processes the agent started that still run (M2R107).
  let agentProcesses = 0;
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
        ...(event.code ? { code: event.code } : {}),
        ...(event.params ? { params: event.params } : {}),
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
  const setStatus = (next: SessionStatus, cause?: ServerText) => {
    status = next;
    publish({
      kind: "status",
      status: next,
      ...(cause
        ? {
            cause: cause.text,
            causeCode: cause.code,
            ...(cause.params ? { causeParams: cause.params } : {}),
          }
        : {}),
    });
  };
  // Pi's name, through the one clip (M2R92). Only a change is handed on, so a loop in an extension stores and says nothing twice.
  const setName = (next: string | null, announce: boolean): void => {
    if (next === name) return;
    name = next;
    deps.onName(next);
    if (announce) publish({ kind: "name", name: next });
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
        emit({
          kind: "notice",
          level: "warning",
          text: "A message was too large to stream.",
          code: SERVER_CODES.messageTooLarge,
        });
      }
      return false;
    }
    deps.publish({ kind: "pi", event });
    return true;
  }

  const loadout = createLoadoutView({ logger, limiter, publish });
  const queue = createQueueGuard();
  const ui = createLiveUi({ handle, clock: deps.clock, logger, limiter, publish, onCardShown });
  const commands = createLiveCommands({ handle, logger });
  const run = createLiveRun({
    handle,
    clock: deps.clock,
    logger,
    setStatus,
    record: deps.record,
    onActivity: deps.onActivity,
    piFile,
    leafId: () => leafId,
    getState,
    queue,
    promptBlocked: () => commands.activity().compacting || commands.structuralInFlight() > 0,
  });

  // What a user waits on keeps the worker (the status is `running` while a run is open); processes the agent left
  // running keep it for 8 h at most (M2R107).
  const state = (): IdleState => {
    const busy =
      status !== "idle" ||
      deps.held?.() === true ||
      run.promptPending() ||
      ui.dialogs().length > 0 ||
      ui.panels().length > 0 ||
      queue.view().count > 0 ||
      commands.inFlight() > 0 ||
      commands.activity().compacting ||
      commands.activity().retry !== null;
    return busy ? "busy" : agentProcesses > 0 ? "background" : "quiet";
  };
  const idle = createLiveIdle({
    clock: deps.clock,
    idleMs: deps.idleMs,
    logger,
    handle,
    cancelPanels: () => ui.cancelPanels(),
    setStatus,
    state,
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
      reportedFile = record.sessionFile;
      piSessionId = record.sessionId;
      leafId = knownId(record.leafId);
      setName(nameOf(record.sessionName), false);
      setStatus("idle");
      idle.touch();
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
        // Only a dialog is a person's work: a status bar that ticks must not keep the worker (M2R108).
        if (ui.onUiRequest(record)) idle.touch();
        return;
      case "approval_request":
        idle.touch();
        ui.onApprovalRequest(record);
        return;
      case "approval_request_invalid":
        ui.onApprovalInvalid(record);
        return;
      case "extension_ui_closed":
        ui.onUiClosed(record.id);
        return;
      case "custom_render":
        idle.touch();
        ui.onPanelRender(record.id, record.lines);
        return;
      case "custom_close":
        ui.onPanelClose(record.id);
        return;
      case "audit":
        deps.record("policy", record.entry);
        return;
      case "taint":
        deps.record("taint", record.epoch);
        return;
      case "health":
        rss = record.rssMb;
        agentProcesses = record.descendants;
        return;
      case "extension_error":
        if (record.extensionPath === POLICY_EXTENSION_PATH && record.event === "policy_update")
          deps.onPolicyRefused?.();
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
        idle.touch();
        const event = record.event;
        // The raw event is never forwarded: the stream carries the guard's bounded view of it.
        // Never forwarded raw: a name is text an extension or the model wrote (M2R92).
        if (event.type === "session_info_changed") {
          setName(nameOf(event.name), true);
          return;
        }
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
        deps.observe?.(event);
        deps.onActivity();
        return;
      }
      case "loadout":
        loadout.onRecord(record.loadout);
        return;
      case "ready":
      case "response":
        return;
    }
  }
  handle.onRecord(onRecord);

  const gone = handle.exited
    .then((exit) => {
      // Whatever fails while the exit is told, the session is forgotten: it must come back with the next prompt.
      try {
        idle.end();
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
        setStatus("cold", idle.stopping() && exit.cause !== "oom" ? undefined : describeExit(exit));
        deps.onActivity();
      } finally {
        deps.onExit(exit);
      }
      deps.onWorkerExit?.({ exit, outputTail: handle.outputTail() });
    })
    .catch((error: unknown) => logger.error("worker_exit_handling_failed", { err: error }));
  if (!handle.send(init)) logger.warn("worker_init_not_sent");

  return {
    ready,
    status: () => status,
    rssMb: () => rss,
    pid: () => handle.pid,
    piFile,
    piSessionId: () => piSessionId,
    name: () => name,
    dialogs: () => ui.dialogs(),
    statuses: () => ui.statuses(),
    widgets: () => ui.widgets(),
    title: () => ui.title(),
    panels: () => ui.panels(),
    notices: () => notices.list(),
    notice: (notice) => publish({ kind: "notice", ...notice }),
    panelInput(id, data) {
      idle.touch();
      ui.panelInput(id, data);
    },
    partial: () => partial.current(),
    leafId: () => leafId,
    loadout: loadout.current,
    runView: () => run.runView(),
    prompt: (text, streamingBehavior, images) =>
      idle.active(() => run.prompt(text, streamingBehavior, images)),
    async abort() {
      if (idle.stopping()) return;
      await idle.active(() => run.abort());
    },
    busy: () =>
      run.tracker.running ||
      run.promptPending() ||
      commands.activity().compacting ||
      commands.structuralInFlight() > 0,
    command: (input) => idle.active(() => commands.command(input)),
    commandsInFlight: () => commands.inFlight(),
    navigated(next) {
      leafId = knownId(next);
    },
    activity: () => commands.activity(),
    queue: queue.view,
    clearQueue: () =>
      idle.stopping()
        ? Promise.resolve({ steering: [], followUp: [], truncated: false })
        : idle.active(() => clearWorkerQueue(handle, logger)),
    answer(dialogId, response) {
      idle.touch();
      return ui.answer(dialogId, response);
    },
    send: (record) => handle.send(record),
    stop: idle.stop,
    stopping: () => idle.stopping(),
    quietSince: () => idle.quietSince(),
    exited: () => gone,
  };
}
