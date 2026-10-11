import type { GetStateData } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

const PROBE_ATTEMPTS = 3;
const PROBE_INTERVAL_MS = 100;

export interface RunTrackerDeps {
  readonly clock: Clock;
  probe(): Promise<GetStateData>;
  onRunStart(): void;
  onRunEnd(result: { aborted: boolean }): void;
}

export interface RunTracker {
  readonly running: boolean;
  onInput(): void;
  /** Counts the `agent_start` events seen. It is how a caller that looked at Pi a moment ago can tell Pi has started since. */
  readonly generation: number;
  /**
   * Ends the open run now, without waiting for `agent_settled`, for the caller that has just seen for itself that Pi has
   * nothing running (an abort that found Pi idle, a prompt answered without a turn). A run can be left open by input Pi
   * rejected or handled without ever starting an agent turn to settle. `generation` is the one the caller read before it
   * asked Pi: if an `agent_start` has come in since, the answer it saw is stale, Pi is running again, and nothing
   * ends. True when a run ended.
   */
  finish(aborted: boolean, generation: number): boolean;
  onEvent(event: { type: string } & Record<string, unknown>): void;
  waitIdle(timeoutMs: number): Promise<boolean>;
  reset(): void;
}

export const isIdle = (state: GetStateData) =>
  !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;

/**
 * A run starts with `agent_start` and ends with `agent_settled`, confirmed by up to three `get_state` probes 100 ms
 * apart (spec C 2.4); new input cancels a probe in progress. When no probe finds Pi idle, the run stays open until
 * the next `agent_settled`.
 */
export function createRunTracker(deps: RunTrackerDeps): RunTracker {
  let running = false;
  let revision = 0;
  let generation = 0;
  const idleWaiters = new Set<() => void>();
  const wakeWaiters = () => {
    for (const wake of [...idleWaiters]) wake();
  };
  const endRun = (aborted: boolean) => {
    running = false;
    deps.onRunEnd({ aborted });
    wakeWaiters();
  };
  const confirm = async (rev: number, aborted: boolean): Promise<void> => {
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      if (attempt > 0) await deps.clock.sleep(PROBE_INTERVAL_MS);
      if (rev !== revision || !running) return;
      const state = await deps.probe().catch(() => null);
      if (rev !== revision || !running) return;
      if (state && isIdle(state)) {
        endRun(aborted);
        return;
      }
    }
  };
  return {
    get running() {
      return running;
    },
    get generation() {
      return generation;
    },
    onInput() {
      revision++;
    },
    finish(aborted, seen) {
      if (!running || seen !== generation) return false;
      // Whatever probe is still on its way would find the run gone.
      revision++;
      endRun(aborted);
      return true;
    },
    onEvent(event) {
      if (event.type === "agent_start") generation++;
      if (event.type === "agent_start" && !running) {
        running = true;
        deps.onRunStart();
      } else if (event.type === "agent_settled") {
        void confirm(revision, event.aborted === true);
      }
    },
    waitIdle(timeoutMs) {
      if (!running) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const done = (idle: boolean) => {
          idleWaiters.delete(onIdle);
          deps.clock.clearTimeout(timer);
          resolve(idle);
        };
        const onIdle = () => done(true);
        const timer = deps.clock.setTimeout(() => done(false), timeoutMs);
        idleWaiters.add(onIdle);
      });
    },
    reset() {
      running = false;
      revision++;
      wakeWaiters();
    },
  };
}
