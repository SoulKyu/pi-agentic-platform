import {
  type Dialog,
  type DialogResponse,
  GetStateData,
  type InitRecord,
  type PartialMessage,
  PapError,
  type PiEvent,
  type ReadyRecord,
  type SessionStatus,
  type SessionStreamEvent,
  type WorkerRecord,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { describeExit, type WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { createCoalescer } from "./coalescer.ts";
import { createLiveRun, isSystemMessage } from "./live-run.ts";
import { createLiveUi } from "./live-ui.ts";
import { createPartialReply } from "./partial.ts";
import type { RunViewState } from "./run-view.ts";
import { clip, outputTailOf } from "./worker-text.ts";

const GET_STATE_TIMEOUT_MS = 2000;
/** Fork to `ready` takes about 0.7 s (S1): a worker that has not said so after this is stuck, not slow. */
export const READY_TIMEOUT_MS = 30_000;
/** The socket allows 1 MiB per frame; an event is sent whole or not at all. */
const MAX_EVENT_BYTES = 1_000_000;
/** The user and the log hear of a thing the daemon keeps doing (cancelling a dialog, dropping an event) this often. */
const SAY_EVERY_MS = 10_000;

export interface LiveSessionDeps {
  readonly handle: WorkerHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  publish(event: SessionStreamEvent): void;
  record(kind: string, data: unknown): void;
  /** Called after every Pi event, when a run ends and when the worker is gone: the moments Pi's file may have appeared. */
  onActivity(): void;
  onExit(exit: WorkerExit): void;
  /** After `onExit`: the exit and the end of what the worker printed (the supervisor keeps 8 KiB), unclipped. */
  onWorkerExit?(info: { exit: WorkerExit; outputTail: string }): void;
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
  /** The reply being written, as the stream has sent it so far (never deltas still pending); null between replies. */
  partial(): PartialMessage | null;
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

export function startLiveSession(deps: LiveSessionDeps, init: InitRecord): LiveSession {
  const { handle, logger } = deps;
  let status: SessionStatus = "starting";
  let rss: number | null = null;
  let piFile: string | undefined;
  let piSessionId: string | undefined;
  const limiter = createRateLimiter(deps.clock, SAY_EVERY_MS);
  const partial = createPartialReply();
  // Every event this session publishes sends the pending deltas first, so text never arrives after what follows it.
  const publish = (event: SessionStreamEvent): void => {
    coalescer.flush();
    deps.publish(event);
  };
  const coalescer = createCoalescer({
    clock: deps.clock,
    emit: (event) => {
      if (publishMeasured(event)) partial.apply(event);
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
        deps.publish({ kind: "notice", level: "warning", text: "A message was too large to stream." });
      }
      return false;
    }
    deps.publish({ kind: "pi", event });
    return true;
  }

  const ui = createLiveUi({ handle, logger, limiter, publish, publishPi: coalescer.push });
  const run = createLiveRun({
    handle,
    clock: deps.clock,
    logger,
    setStatus,
    record: deps.record,
    onActivity: deps.onActivity,
    piFile: () => piFile,
    getState,
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

  function onRecord(record: WorkerRecord): void {
    switch (record.type) {
      case "extension_ui_request":
        ui.onUiRequest(record);
        return;
      case "extension_ui_closed":
        ui.onUiClosed(record.id);
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
      case "pi_event": {
        const event = record.event;
        run.onPiEvent(event);
        // Pi's system prompt travels as a message. It stays here: it is internal and may carry the user's AGENTS.md (R107).
        if (!isSystemMessage(event)) coalescer.push(event);
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
    const wasRunning = run.onExit();
    for (const dialog of ui.clear()) publish({ kind: "dialog_closed", id: dialog.id });
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
    partial: () => partial.current(),
    runView: () => run.runView(),
    prompt: (text, streamingBehavior) => run.prompt(text, streamingBehavior),
    abort: () => run.abort(),
    answer: (dialogId, response) => ui.answer(dialogId, response),
    stop: async () => {
      await handle.stop();
    },
  };
}
