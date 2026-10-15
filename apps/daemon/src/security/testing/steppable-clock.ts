import { type Clock, createSystemClock, type TimerHandle } from "../../kernel/clock.ts";

/** A timer this long or longer is parked until the test moves time; shorter ones run on the real clock. */
const PARKED_FROM_MS = 60_000;

export interface SteppableClock extends Clock {
  /** Moves time forward and runs the parked timers that are due, oldest first. */
  advance(ms: number): Promise<void>;
}

/**
 * The system clock with a hand. A real daemon needs real time for its workers, its sockets and its short timers (an
 * outbox wake-up, a start), while a test must pass ten minutes of waiting without waiting: timers of a minute or more
 * are parked, and `advance` runs them. Nothing here sleeps.
 */
export function createSteppableClock(): SteppableClock {
  const system = createSystemClock();
  const parked = new Map<number, { at: number; fn: () => void }>();
  let offset = 0;
  let nextId = 1_000_000;
  const now = (): number => Date.now() + offset;
  const clock: SteppableClock = {
    now,
    setTimeout(fn, ms): TimerHandle {
      if (ms < PARKED_FROM_MS) return system.setTimeout(fn, ms);
      const id = nextId++;
      parked.set(id, { at: now() + ms, fn });
      return { id };
    },
    clearTimeout(handle) {
      if (!parked.delete(handle.id)) system.clearTimeout(handle);
    },
    sleep: (ms) => new Promise<void>((resolve) => void clock.setTimeout(resolve, ms)),
    async advance(ms) {
      offset += ms;
      for (;;) {
        const due = [...parked.entries()]
          .filter(([, timer]) => timer.at <= now())
          .sort((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (!first) break;
        parked.delete(first[0]);
        first[1].fn();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  };
  return clock;
}
