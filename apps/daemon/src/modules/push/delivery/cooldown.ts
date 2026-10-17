import type { Clock } from "../../../kernel/clock.ts";
import { DELIVERY } from "./meta.ts";

/**
 * 5 s per dedupe key (M12R3). A map of 256 keys: when it is full of fresh keys a new key is refused, never an old
 * one evicted, so a flood of distinct keys cannot reopen a key that is still cooling.
 */
export function createCooldown(clock: Clock): { free(key: string): boolean; reserve(key: string): boolean } {
  const until = new Map<string, number>();
  return {
    /** Whether `reserve` would succeed, without taking the window: `decide` asks, the handler reserves only on `send`. */
    free(key) {
      const now = clock.now();
      const held = until.get(key);
      if (held !== undefined) return held <= now;
      let fresh = 0;
      for (const at of until.values()) if (at > now) fresh += 1;
      return fresh < DELIVERY.cooldownKeys;
    },
    reserve(key) {
      if (!this.free(key)) return false;
      const now = clock.now();
      if (until.size >= DELIVERY.cooldownKeys) for (const [k, at] of until) if (at <= now) until.delete(k);
      until.set(key, now + DELIVERY.cooldownMs);
      return true;
    },
  };
}
