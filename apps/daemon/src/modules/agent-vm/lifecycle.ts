import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";

/** RT-40: this many crashes within the window pause the box. */
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60_000;
/** Boxes (by `boxKey`) with a crash on record: one entry per box of this daemon, dropped by `clear` (Resume) or when its window empties. */
export interface CrashLog {
  /** Records a crash now; true when this one is the limit's. */
  record(box: string): boolean;
  clear(box: string): void;
}

export function createCrashLog(clock: Clock): CrashLog {
  const crashes = new Map<string, number[]>();
  return {
    record(box) {
      const now = clock.now();
      const recent = (crashes.get(box) ?? []).filter((at) => now - at < CRASH_WINDOW_MS);
      recent.push(now);
      crashes.set(box, recent);
      return recent.length >= CRASH_LIMIT;
    },
    clear(box) {
      crashes.delete(box);
    },
  };
}

/** R29: a VM costs its `memoryMb` and the fixed overhead; a start that does not fit under the cap is refused. */
export function fitsCapacity(runningMemoryMb: readonly number[], memoryMb: number, capMb: number): boolean {
  const used = runningMemoryMb.reduce((sum, each) => sum + each + VM_OVERHEAD_MB, 0);
  return used + memoryMb + VM_OVERHEAD_MB <= capMb;
}

/** Calls `onIdle` once `idleMs` after the last worker left, never while one lives; `idleMs` 0 never calls it. */
export interface IdleStop {
  workerStarted(): void;
  workerEnded(): void;
  /** Arms the timer for a VM that has no worker yet (a start whose spawn failed). */
  armIfEmpty(): void;
  cancel(): void;
  readonly live: number;
}

export function createIdleStop(clock: Clock, idleMs: number, onIdle: () => void): IdleStop {
  let live = 0;
  let timer: TimerHandle | undefined;
  const cancel = (): void => {
    if (timer) clock.clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    cancel();
    if (idleMs === 0) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (live === 0) onIdle();
    }, idleMs);
  };
  return {
    workerStarted() {
      live++;
      cancel();
    },
    workerEnded() {
      live = Math.max(0, live - 1);
      if (live === 0) arm();
    },
    armIfEmpty() {
      if (live === 0) arm();
    },
    cancel,
    get live() {
      return live;
    },
  };
}
