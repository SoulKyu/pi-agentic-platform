import type { Clock } from "../../kernel/clock.ts";

/** M10R53: 10 refused deliveries within 60 s on one trigger block failing requests for the next 60 s. */
export const BACKOFF = { failures: 10, windowMs: 60_000, blockMs: 60_000 } as const;

interface State {
  count: number;
  since: number;
  until: number;
}

export interface Backoff {
  /** True while failing requests for this trigger (null: an unknown id) are answered 429. Never judges a request that authenticated. */
  blocked(triggerId: string | null): boolean;
  /** Records a refused delivery; true when this one started a block. Nothing is counted while blocked. */
  failed(triggerId: string | null): boolean;
  /** A deleted trigger's entry goes with it. */
  forget(triggerId: string): void;
  size(): number;
}

const SHARED = "";

/**
 * Failure counts per trigger. An entry exists only for a trigger that exists (the route calls `failed(id)` after its
 * lookup) plus the shared one for unknown ids, so the map is bounded by the per-owner trigger cap and never evicts.
 */
export function createBackoff(clock: Clock): Backoff {
  const states = new Map<string, State>();
  const keyOf = (id: string | null): string => id ?? SHARED;
  return {
    blocked: (id) => clock.now() < (states.get(keyOf(id))?.until ?? 0),
    failed(id) {
      const now = clock.now();
      const key = keyOf(id);
      const state = states.get(key) ?? { count: 0, since: now, until: 0 };
      states.set(key, state);
      if (now < state.until) return false;
      if (state.count === 0 || now - state.since >= BACKOFF.windowMs) {
        state.count = 0;
        state.since = now;
      }
      state.count++;
      if (state.count < BACKOFF.failures) return false;
      state.count = 0;
      state.until = now + BACKOFF.blockMs;
      return true;
    },
    forget: (id) => void states.delete(id),
    size: () => states.size,
  };
}
