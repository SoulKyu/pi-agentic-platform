import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import { SHUTDOWN_GRACE_MS, SIGKILL_WAIT_MS, SIGTERM_GRACE_MS } from "./kernel/supervisor/kill-ladder.ts";

/** The longest a graceful stop may take: one worker kill ladder, then closing the rest. A hang past it is cut. */
export const STOP_DEADLINE_MS = SHUTDOWN_GRACE_MS + SIGTERM_GRACE_MS + SIGKILL_WAIT_MS + 5_000;

export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export interface ShutdownDeps {
  /** The daemon's graceful stop: workers first, then the sockets and the database (R104). */
  stop(): Promise<void>;
  /** SIGKILLs every worker group that is still up; only for the paths where the graceful stop is given up. */
  killWorkers(): number;
  exit(code: number): void;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface Shutdown {
  /**
   * The first call starts the graceful stop and exits with `code` when it is done. A second call (a second signal)
   * and the deadline both kill the workers and exit non-zero at once, so nothing can keep the process alive.
   */
  trigger(reason: string, code?: number): void;
}

export function createShutdown(deps: ShutdownDeps): Shutdown {
  let started = false;
  let finished = false;
  let deadline: TimerHandle | null = null;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    if (deadline) deps.clock.clearTimeout(deadline);
    deps.exit(code);
  };
  const giveUp = (): void => {
    deps.killWorkers();
    finish(1);
  };
  return {
    trigger(reason, code = 0) {
      if (finished) return;
      if (started) {
        deps.logger.warn("shutdown_forced", { reason });
        giveUp();
        return;
      }
      started = true;
      deps.logger.info("shutting_down", { reason });
      deadline = deps.clock.setTimeout(() => {
        deps.logger.error("shutdown_timeout", { deadlineMs: STOP_DEADLINE_MS });
        giveUp();
      }, STOP_DEADLINE_MS);
      deps.stop().then(
        () => finish(code),
        (error: unknown) => {
          deps.logger.error("shutdown_failed", { err: error });
          giveUp();
        },
      );
    },
  };
}

export interface ForceKillDeps {
  /** SIGKILLs the worker process groups; returns how many. */
  killWorkerGroups(): number;
  /** SIGKILLs the worker scopes of this home (what Pi started in groups of its own lives there). */
  killScopes(): void;
  readonly logger: Logger;
}

/** The kill of a given-up stop: the groups, then the scopes; one failing never keeps the other from running. */
export function forceKill(deps: ForceKillDeps): () => number {
  return () => {
    let killed = 0;
    try {
      killed = deps.killWorkerGroups();
    } catch (error) {
      deps.logger.error("force_kill_groups_failed", { err: error });
    }
    try {
      deps.killScopes();
    } catch (error) {
      deps.logger.error("force_kill_scopes_failed", { err: error });
    }
    return killed;
  };
}

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** `on` and not `once`: the second signal is what forces the exit. */
export function watchSignals(shutdown: Shutdown, source: SignalSource): void {
  for (const signal of SHUTDOWN_SIGNALS) source.on(signal, () => shutdown.trigger(signal));
}
