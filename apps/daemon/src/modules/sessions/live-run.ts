import { type GetStateData, PapError, type PiEvent, type SessionStatus } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { fileSizeOrZero } from "./pi-files.ts";
import { createRunTracker, isIdle, type RunTracker } from "./run-tracker.ts";
import { createRunView, type RunViewState } from "./run-view.ts";
import { clip } from "./worker-text.ts";

const ABORT_SETTLE_MS = 5000;

/** Pi's system prompt travels as a message. It stays inside the daemon: it may carry the user's AGENTS.md (R107). */
export const isSystemMessage = (event: PiEvent): boolean =>
  (event.message as { role?: unknown } | null | undefined)?.role === "system";

export interface LiveRunDeps {
  readonly handle: WorkerHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  setStatus(next: SessionStatus): void;
  record(kind: string, data: unknown): void;
  onActivity(): void;
  piFile(): string | undefined;
  getState(): Promise<GetStateData>;
}

export interface LiveRun {
  readonly tracker: RunTracker;
  /** The tracker sees every event; the run view takes a `message_end` only when it is not Pi's system message. */
  onPiEvent(event: PiEvent): void;
  prompt(
    text: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<{ disposition: "started" | "queued" | "handled" }>;
  abort(): Promise<void>;
  runView(): RunViewState | null;
  /** The worker is gone: returns whether a run was open, and resets the tracker and the view. */
  onExit(): boolean;
}

export function createLiveRun(deps: LiveRunDeps): LiveRun {
  const { handle, logger, getState } = deps;
  const view = createRunView();
  const tracker = createRunTracker({
    clock: deps.clock,
    probe: getState,
    onRunStart: () => {
      // The file is complete up to here: the last run settled before this one began (R38).
      const file = deps.piFile();
      view.begin(file ? fileSizeOrZero(file) : 0);
      deps.setStatus("running");
      deps.record("run_start", { origin: "user" });
    },
    onRunEnd: ({ aborted }) => {
      view.end();
      deps.setStatus("idle");
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

  return {
    tracker,
    onPiEvent(event) {
      tracker.onEvent(event);
      if (!isSystemMessage(event) && event.type === "message_end") view.push(event.message);
    },
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
    runView: () => view.state(),
    onExit() {
      const wasRunning = tracker.running;
      tracker.reset();
      view.end();
      return wasRunning;
    },
  };
}
