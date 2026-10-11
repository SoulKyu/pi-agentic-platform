import type { Clock } from "../../kernel/clock.ts";

export interface RateLimiter {
  /**
   * Whether the thing named `key` may be said now. At most one call in each window is allowed; the others are
   * counted, and the count is handed to the next one that is, so the log can say how many it left out.
   */
  check(key: string): { allowed: boolean; suppressed: number };
}

/** A window per key. The keys are a small fixed set of the caller's (a reason, a kind of event), so nothing grows. */
export function createRateLimiter(clock: Clock, intervalMs: number): RateLimiter {
  const windows = new Map<string, { startedAt: number; suppressed: number }>();
  return {
    check(key) {
      const now = clock.now();
      const window = windows.get(key);
      if (!window || now - window.startedAt >= intervalMs) {
        windows.set(key, { startedAt: now, suppressed: 0 });
        return { allowed: true, suppressed: window?.suppressed ?? 0 };
      }
      window.suppressed++;
      return { allowed: false, suppressed: window.suppressed };
    },
  };
}
