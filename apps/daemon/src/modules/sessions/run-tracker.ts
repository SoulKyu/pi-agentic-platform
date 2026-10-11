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
  onEvent(event: { type: string } & Record<string, unknown>): void;
  waitIdle(timeoutMs: number): Promise<boolean>;
  reset(): void;
}

const isIdle = (state: GetStateData) =>
  !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;

/**
 * A run starts with `agent_start` and ends with `agent_settled`, confirmed by up to three `get_state` probes 100 ms
 * apart (spec C 2.4); new input cancels a probe in progress. When no probe finds Pi idle, the run stays open until
 * the next `agent_settled`.
 */
export function createRunTracker(deps: RunTrackerDeps): RunTracker {
  let running = false;
  let revision = 0;
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
    onInput() {
      revision++;
    },
    onEvent(event) {
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
