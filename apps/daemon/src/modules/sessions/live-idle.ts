import { PapError, type SessionStatus } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { createIdleRelease, type IdleState } from "./idle-release.ts";

export interface LiveIdle {
  /** Records an activity of the kinds M2R108 lists. */
  touch(): void;
  /** The worker was asked to stop (a release, the daemon closing): nothing is sent to it any more (M2R112). */
  stopping(): boolean;
  /**
   * Runs a client command: it re-arms the timer when it starts and when it ends, so a long one is not followed by a
   * release at once. Refused with `worker_failed` before anything is sent when the worker is stopping.
   */
  active<T>(work: () => Promise<T>): Promise<T>;
  /** Stops the worker for good and its timer with it; resolves when it has exited. */
  stop(): Promise<void>;
  /** The worker has exited: the timer goes. */
  end(): void;
}

/**
 * spec C 2.1: after `idleMs` with nothing pending the worker is told to close, which tells its extensions
 * (`session_shutdown`), and the session shows `releasing` until the exit, which shows `cold`.
 */
export function createLiveIdle(deps: {
  readonly clock: Clock;
  readonly idleMs: number;
  readonly logger: Logger;
  readonly handle: WorkerHandle;
  cancelPanels(): void;
  setStatus(status: SessionStatus): void;
  state(): IdleState;
}): LiveIdle {
  let requestedStop = false;
  const idle = createIdleRelease({
    clock: deps.clock,
    idleMs: deps.idleMs,
    state: deps.state,
    release: () => {
      if (requestedStop) return;
      deps.setStatus("releasing");
      stop().catch((error: unknown) => deps.logger.warn("worker_stop_failed", { err: error }));
    },
  });
  async function stop(): Promise<void> {
    requestedStop = true;
    idle.stop();
    deps.cancelPanels();
    await deps.handle.stop();
  }
  return {
    touch: () => idle.touch(),
    stopping: () => requestedStop,
    async active(work) {
      if (requestedStop) throw new PapError("worker_failed");
      idle.touch();
      try {
        return await work();
      } finally {
        idle.touch();
      }
    },
    stop,
    end: () => idle.stop(),
  };
}
