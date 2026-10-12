import type { Clock } from "../../kernel/clock.ts";

const BASE_MS = 1000;
const MAX_MS = 60_000;
const RESET_AFTER_MS = 5 * 60_000;
const MAX_KEYS = 10_000;

export interface Throttle {
  retryAfterMs(keys: readonly string[]): number;
  fail(keys: readonly string[]): void;
  succeed(keys: readonly string[]): void;
  size(): number;
}

interface Entry {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

const backoffMs = (failures: number) => Math.min(BASE_MS * 2 ** Math.min(failures - 1, 31), MAX_MS);

export function createThrottle(clock: Clock): Throttle {
  const entries = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry && clock.now() - entry.lastFailureAt >= RESET_AFTER_MS) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    retryAfterMs: (keys) => Math.max(0, ...keys.map((key) => (live(key)?.blockedUntil ?? 0) - clock.now())),
    fail(keys) {
      if (entries.size > MAX_KEYS) for (const key of [...entries.keys()]) live(key);
      for (const key of keys) {
        const entry = live(key) ?? { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
        entry.failures += 1;
        entry.lastFailureAt = clock.now();
        entry.blockedUntil = clock.now() + backoffMs(entry.failures);
        // Re-inserted last, so the oldest failure is the first to go when the cap is crossed.
        entries.delete(key);
        entries.set(key, entry);
      }
      while (entries.size > MAX_KEYS) entries.delete(entries.keys().next().value as string);
    },
    succeed(keys) {
      for (const key of keys) entries.delete(key);
    },
    size: () => entries.size,
  };
}
