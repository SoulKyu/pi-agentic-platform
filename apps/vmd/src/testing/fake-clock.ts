import type { Clock } from "../clock.ts";

export interface FakeClock extends Clock {
  advance(ms: number): Promise<void>;
  pending(): number;
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return { id };
    },
    clearTimeout(handle) {
      timers.delete(handle.id);
    },
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
}
