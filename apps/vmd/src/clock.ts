/** The same shape as the daemon's kernel `Clock` (pap-vmd imports nothing from the daemon): every timer goes through it. */
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

// Node clamps a delay above 2^31 - 1 ms to 1 ms: a longer wait runs as a chain of hops.
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createSystemClock(): Clock {
  const timers = new Map<number, NodeJS.Timeout>();
  let nextId = 1;
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = nextId++;
      const arm = (remaining: number): void => {
        const timer = setTimeout(
          () => {
            if (remaining > MAX_TIMER_MS) return arm(remaining - MAX_TIMER_MS);
            timers.delete(id);
            fn();
          },
          Math.min(remaining, MAX_TIMER_MS),
        );
        timer.unref();
        timers.set(id, timer);
      };
      arm(ms);
      return { id };
    },
    clearTimeout(handle) {
      const timer = timers.get(handle.id);
      if (timer) clearTimeout(timer);
      timers.delete(handle.id);
    },
  };
}
