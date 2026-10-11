import {
  type Dialog,
  type DialogResponse,
  GetStateData,
  type InitRecord,
  PapError,
  type PiEvent,
  type ReadyRecord,
  type SessionStatus,
  type SessionStreamEvent,
  type UiRequestRecord,
  type WorkerRecord,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { describeExit, type WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { type CancelReason, createDialogRegistry } from "./dialogs.ts";
import { fileSizeOrZero } from "./pi-files.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { createRunTracker, isIdle } from "./run-tracker.ts";
import { createRunView, type RunViewState } from "./run-view.ts";

const ABORT_SETTLE_MS = 5000;
const GET_STATE_TIMEOUT_MS = 2000;
/** Fork to `ready` takes about 0.7 s (S1): a worker that has not said so after this is stuck, not slow. */
export const READY_TIMEOUT_MS = 30_000;
/** The socket allows 1 MiB per frame; an event is sent whole or not at all. */
const MAX_EVENT_BYTES = 1_000_000;
/** The user and the log hear of a thing the daemon keeps doing (cancelling a dialog, dropping an event) this often. */
const SAY_EVERY_MS = 10_000;
/** What the daemon logs of a worker's output or error text, counted from the end for output (R66, R102). */
const LOG_CHARS = 2000;
/** An event name an extension error may show to the user; anything else is left out, never cut. */
const SAFE_EVENT_NAME = /^[a-z][a-z0-9_:.-]{0,63}$/;

const CANCEL_NOTICES: Partial<Record<CancelReason, string>> = {
  too_large: "An extension asked a question that was too large to show. It was cancelled.",
  limit: "An extension asked a question while too many were waiting. It was cancelled.",
};

export interface LiveSessionDeps {
  readonly handle: WorkerHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  publish(event: SessionStreamEvent): void;
  record(kind: string, data: unknown): void;
  /** Called after every Pi event, when a run ends and when the worker is gone: the moments Pi's file may have appeared. */
  onActivity(): void;
  onExit(exit: WorkerExit): void;
}

export interface LiveSession {
  readonly ready: Promise<ReadyRecord>;
  status(): SessionStatus;
  rssMb(): number | null;
  pid(): number | undefined;
  /** Where Pi writes (or wrote) this session, from `ready`. It does not exist until the first user message. */
  piFile(): string | undefined;
  /** Pi's id for the session, from `ready`. */
  piSessionId(): string | undefined;
  dialogs(): Dialog[];
  /** What a run in progress has produced that the session file does not have yet; null between runs. */
  runView(): RunViewState | null;
  prompt(
    text: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<{ disposition: "started" | "queued" | "handled" }>;
  abort(): Promise<void>;
  answer(dialogId: string, response: DialogResponse): void;
  stop(): Promise<void>;
}

const isSystemMessage = (event: PiEvent): boolean =>
  (event.message as { role?: unknown } | null | undefined)?.role === "system";

const clip = (text: string): string => (text.length > LOG_CHARS ? `${text.slice(0, LOG_CHARS)}…` : text);

export function startLiveSession(deps: LiveSessionDeps, init: InitRecord): LiveSession {
  const { handle, logger } = deps;
  let status: SessionStatus = "starting";
  let rss: number | null = null;
  let piFile: string | undefined;
  let piSessionId: string | undefined;
  const dialogs = createDialogRegistry();
  const view = createRunView();
  const limiter = createRateLimiter(deps.clock, SAY_EVERY_MS);
  const setStatus = (next: SessionStatus, cause?: string) => {
    status = next;
    deps.publish({ kind: "status", status: next, ...(cause ? { cause } : {}) });
  };
  const getState = async (): Promise<GetStateData> => {
    const response = await handle.request({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
    const parsed = GetStateData.safeParse(response.data);
    if (!response.success || !parsed.success) throw new PapError("worker_failed");
    return parsed.data;
  };
  const tracker = createRunTracker({
    clock: deps.clock,
    probe: getState,
    onRunStart: () => {
      // The file is complete up to here: the last run settled before this one began (R38).
      view.begin(piFile ? fileSizeOrZero(piFile) : 0);
      setStatus("running");
      deps.record("run_start", { origin: "user" });
    },
    onRunEnd: ({ aborted }) => {
      view.end();
      setStatus("idle");
      deps.record("run_end", { aborted });
      deps.onActivity();
    },
  });

  // Input Pi rejected or handled without a turn leaves no agent_settled to wait for. If the daemon holds a run open and
  // Pi shows nothing running, the run is over (R111b). Not awaited: the answer to the client does not wait for a
  // probe. The generation read first keeps it from ending a run that began since.
  function closeStaleRun(): void {
    if (!tracker.running) return;
    const generation = tracker.generation;
    void getState()
      .then((state) => {
        if (isIdle(state)) tracker.finish(false, generation);
      })
      .catch(() => undefined);
  }

  const ready = new Promise<ReadyRecord>((resolve, reject) => {
    const timer = deps.clock.setTimeout(() => {
      off();
      logger.warn("worker_not_ready", { output: outputTail() });
      void handle.stop();
      reject(new PapError("worker_failed"));
    }, READY_TIMEOUT_MS);
    const off = handle.onRecord((record) => {
      if (record.type !== "ready") return;
      off();
      deps.clock.clearTimeout(timer);
      piFile = record.sessionFile;
      piSessionId = record.sessionId;
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

  // The end of what the worker printed, not the start: that is where it says why it stopped. Exactly LOG_CHARS at
  // most, marker included, so that the logger's own clip (which keeps the start) leaves it alone.
  function outputTail(): string {
    const tail = handle.outputTail();
    return tail.length > LOG_CHARS ? `…${tail.slice(-(LOG_CHARS - 1))}` : tail;
  }

  // An event is sent whole or not at all, and every kind of event is measured: a `text_end` carries the whole text of
  // a block and a `toolcall_end` the whole call, so a delta is the only small one and it costs nothing to look.
  function publishPi(event: PiEvent): void {
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) {
      const said = limiter.check("event_too_large");
      if (said.allowed) {
        logger.warn("pi_event_too_large", { type: clip(event.type), suppressed: said.suppressed });
        deps.publish({ kind: "notice", level: "warning", text: "A message was too large to stream." });
      }
      return;
    }
    deps.publish({ kind: "pi", event });
  }

  function onUiRequest(record: UiRequestRecord): void {
    const verdict = dialogs.offer(record);
    if (verdict.kind === "opened") {
      deps.publish({ kind: "dialog_open", dialog: verdict.dialog });
    } else if (verdict.kind === "cancel") {
      // Every dialog is answered; only the telling is spaced out, so an extension that asks in a loop cannot flood
      // the user's screen or the log.
      handle.send({ type: "extension_ui_response", id: record.id, cancelled: true });
      const said = limiter.check(`dialog_${verdict.reason}`);
      if (!said.allowed) return;
      logger.warn("dialog_cancelled", {
        reason: verdict.reason,
        method: clip(record.method).slice(0, 64),
        suppressed: said.suppressed,
      });
      const notice = CANCEL_NOTICES[verdict.reason];
      if (notice) deps.publish({ kind: "notice", level: "warning", text: notice });
    } else {
      publishPi(record);
    }
  }

  // The worker's own words are logged, clipped, and never sent on: a client gets a fixed text (R66).
  function onExtensionError(record: Extract<WorkerRecord, { type: "extension_error" }>): void {
    logger.warn("extension_error", {
      extensionPath: clip(record.extensionPath),
      event: clip(record.event),
      error: clip(record.error),
    });
    const during = SAFE_EVENT_NAME.test(record.event) ? ` during ${record.event}` : "";
    deps.publish({ kind: "notice", level: "error", text: `An extension failed${during}.` });
  }

  function onRecord(record: WorkerRecord): void {
    switch (record.type) {
      case "extension_ui_request":
        onUiRequest(record);
        return;
      case "extension_ui_closed":
        if (dialogs.take(record.id)) deps.publish({ kind: "dialog_closed", id: record.id });
        return;
      case "audit":
        deps.record("policy", record.entry);
        return;
      case "health":
        rss = record.rssMb;
        return;
      case "extension_error":
        onExtensionError(record);
        return;
      case "pi_event": {
        const event = record.event;
        tracker.onEvent(event);
        // Pi's system prompt travels as a message. It stays here: it is internal and may carry the user's AGENTS.md (R107).
        if (!isSystemMessage(event)) {
          if (event.type === "message_end") view.push(event.message);
          publishPi(event);
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
    const wasRunning = tracker.running;
    tracker.reset();
    view.end();
    for (const dialog of dialogs.clear()) deps.publish({ kind: "dialog_closed", id: dialog.id });
    if (wasRunning) deps.record("run_end", { interrupted: exit.cause });
    deps.record("worker_exit", exit);
    if (exit.cause === "clean") logger.info("worker_exited", { ...exit });
    else logger.warn("worker_exited", { ...exit, output: outputTail() });
    setStatus("cold", describeExit(exit));
    deps.onActivity();
    deps.onExit(exit);
  });
  if (!handle.send(init)) logger.warn("worker_init_not_sent");

  return {
    ready,
    status: () => status,
    rssMb: () => rss,
    pid: () => handle.pid,
    piFile: () => piFile,
    piSessionId: () => piSessionId,
    dialogs: () => dialogs.list(),
    runView: () => view.state(),
    async prompt(text, streamingBehavior) {
      tracker.onInput();
      // No timeout: an extension command answers only when it ends, possibly after a dialog the user takes minutes
      // over (R99). The wait ends with the worker. Answers to dialogs do not depend on it.
      const response = await handle.request({
        type: "prompt",
        message: text,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      if (!response.success) {
        logger.info("prompt_rejected", { error: clip(response.error ?? "") });
        closeStaleRun();
        throw new PapError("prompt_rejected");
      }
      const disposition = (response.data as { disposition?: unknown } | undefined)?.disposition;
      if (disposition === "handled") closeStaleRun();
      return { disposition: disposition === "queued" || disposition === "handled" ? disposition : "started" };
    },
    // One deadline for the whole abort: a worker that has not settled 5 s after it was asked is terminated.
    async abort() {
      // Read before asking: a run that begins while get_state is on its way is not the run this abort found.
      const generation = tracker.generation;
      const state = await getState().catch(() => null);
      if (!state || state.isCompacting) {
        await handle.stop();
        return;
      }
      if (isIdle(state)) {
        // Pi had nothing running when it answered, so the run the daemon still holds open (input Pi rejected or
        // handled without a turn) is over, unless Pi started again since: records arrive in a batch, and this
        // continuation can run after a prompt's `started` and its `agent_start` (R111b). Pi is told to abort all the
        // same. It does nothing if it is idle, and stops the run if the answer was stale. The worker is left alone.
        handle.request({ type: "abort" }, ABORT_SETTLE_MS).catch(() => undefined);
        tracker.finish(true, generation);
        return;
      }
      const settled = tracker.waitIdle(ABORT_SETTLE_MS);
      handle.request({ type: "abort" }, ABORT_SETTLE_MS).catch(() => undefined);
      if (!(await settled)) await handle.stop();
    },
    answer(dialogId, response) {
      if (!dialogs.take(dialogId)) throw new PapError("not_found");
      const delivered = handle.send({ type: "extension_ui_response", id: dialogId, ...response });
      deps.publish({ kind: "dialog_closed", id: dialogId });
      if (!delivered) throw new PapError("worker_failed");
    },
    stop: async () => {
      await handle.stop();
    },
  };
}
