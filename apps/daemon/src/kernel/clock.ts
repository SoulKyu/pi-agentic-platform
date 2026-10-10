export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  sleep(ms: number): Promise<void>;
}

// Node clamps a delay above 2^31 - 1 ms (about 24.8 days) to 1 ms, so a 30-day expiry would fire at once.
export const MAX_TIMER_MS = 2 ** 31 - 1;

export function createSystemClock(): Clock {
  const timers = new Map<number, NodeJS.Timeout>();
  let nextId = 1;
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = nextId++;
      // Long delays run as a chain of hops; only the hop that is armed is tracked, so clear stops the chain.
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
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        clock.setTimeout(resolve, ms);
      }),
  };
  return clock;
}

export interface FakeClock extends Clock {
  advance(ms: number): Promise<void>;
  pending(): number;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: FakeClock = {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return { id };
    },
    clearTimeout(handle) {
      timers.delete(handle.id);
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        clock.setTimeout(resolve, ms);
      }),
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        await flush();
        let dueId: number | null = null;
        let due: { at: number; fn: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (dueId === null || due === null) break;
        timers.delete(dueId);
        current = due.at;
        due.fn();
      }
      current = target;
      await flush();
    },
    pending: () => timers.size,
  };
  return clock;
}
