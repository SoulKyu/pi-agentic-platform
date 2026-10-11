import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export interface IdleRelease {
  /** Records an activity (M2R108) and makes sure a check is due; cheap enough to call for every event of a run. */
  touch(): void;
  /** Clears the timer for good: a later `touch` arms nothing. */
  stop(): void;
}

/** A worker whose only work left is processes its agent started is released anyway after this (owner R2-2). */
export const BACKGROUND_RELEASE_MS = 8 * 60 * 60_000;

/** `busy`: something a user waits on; `background`: only processes the agent left running; `quiet`: nothing. */
export type IdleState = "busy" | "background" | "quiet";

/**
 * spec C 2.1: a worker idle for `idleMs` with nothing pending is released; its session goes cold, not away.
 *
 * One timer at most. A touch only moves the last activity; the timer, when it fires, finds out how long it was quiet
 * and sleeps the rest, so a stream of events costs a clock read each and no timer. A busy session is looked at again
 * after `idleMs`; one with only agent processes left is looked at again no later than `backgroundMs` after its last
 * activity, so it is released at that moment and not at the next multiple of `idleMs`. `idleMs <= 0` turns it off.
 */
export function createIdleRelease(deps: {
  clock: Clock;
  idleMs: number;
  backgroundMs?: number;
  state(): IdleState;
  release(): void;
}): IdleRelease {
  const backgroundMs = deps.backgroundMs ?? BACKGROUND_RELEASE_MS;
  let timer: TimerHandle | null = null;
  let stopped = false;
  let lastActivity = deps.clock.now();
  const arm = (ms: number): void => {
    timer = deps.clock.setTimeout(check, Math.max(1, ms));
  };
  function check(): void {
    timer = null;
    if (stopped) return;
    const quietFor = deps.clock.now() - lastActivity;
    if (quietFor < deps.idleMs) return arm(deps.idleMs - quietFor);
    const state = deps.state();
    if (state === "quiet") return deps.release();
    if (state === "background") {
      if (quietFor >= backgroundMs) return deps.release();
      return arm(Math.min(deps.idleMs, backgroundMs - quietFor));
    }
    arm(deps.idleMs);
  }
  return {
    touch() {
      if (stopped || deps.idleMs <= 0) return;
      lastActivity = deps.clock.now();
      if (!timer) arm(deps.idleMs);
    },
    stop() {
      stopped = true;
      if (timer) deps.clock.clearTimeout(timer);
      timer = null;
    },
  };
}
