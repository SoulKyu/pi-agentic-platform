import type { Clock } from "../../kernel/clock.ts";

const BASE_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;
const MAX_MS = MAX_BACKOFF_MS;
const RESET_AFTER_MS = 5 * 60_000;
const MAX_KEYS = 10_000;

export interface Throttle {
  retryAfterMs(keys: readonly string[]): number;
  /** False when the table is full of live lockouts and a new key does not fit: nothing was recorded, refuse the attempt. */
  fail(keys: readonly string[]): boolean;
  succeed(keys: readonly string[]): void;
  size(): number;
}

interface Entry {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

const backoffMs = (failures: number) => Math.min(BASE_MS * 2 ** Math.min(failures - 1, 31), MAX_MS);

export interface ThrottleOptions {
  /** `refuse`: never drop a live lockout, `fail` returns false instead. `evict`: drop the oldest failure. */
  readonly whenFull: "refuse" | "evict";
}

export function createThrottle(clock: Clock, options: ThrottleOptions): Throttle {
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
      // Entries are ordered by last failure, so the expired ones are all at the head.
      for (const [key, entry] of entries) {
        if (clock.now() - entry.lastFailureAt < RESET_AFTER_MS) break;
        entries.delete(key);
      }
      if (options.whenFull === "refuse") {
        const added = new Set(keys.filter((key) => !entries.has(key))).size;
        if (entries.size + added > MAX_KEYS) return false;
      }
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
      return true;
    },
    succeed(keys) {
      for (const key of keys) entries.delete(key);
    },
    size: () => entries.size,
  };
}
