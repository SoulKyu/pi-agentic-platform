import { AUTOMATION_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

const WINDOW_MS = 60_000;

export interface HookRate {
  /** Counts one authenticated delivery of the trigger; `rate` from the 61st in its minute (M10R55). */
  count(triggerId: string): "ok" | "rate";
  /** A deleted trigger's entry goes with it. */
  forget(triggerId: string): void;
  size(): number;
}

/**
 * Deliveries per trigger in a fixed window that opens at the first one. Synchronous, with no `await` between the read
 * and the write, so concurrent deliveries cannot both take the last place. An entry exists only for a trigger that
 * authenticated a delivery, so the map is bounded by the per-owner trigger cap.
 */
export function createHookRate(clock: Clock): HookRate {
  const windows = new Map<string, { since: number; count: number }>();
  return {
    count(triggerId) {
      const now = clock.now();
      let window = windows.get(triggerId);
      if (window === undefined || now - window.since >= WINDOW_MS) {
        window = { since: now, count: 0 };
        windows.set(triggerId, window);
      }
      window.count += 1;
      return window.count > AUTOMATION_LIMITS.webhookPerMinute ? "rate" : "ok";
    },
    forget: (triggerId) => void windows.delete(triggerId),
    size: () => windows.size,
  };
}
