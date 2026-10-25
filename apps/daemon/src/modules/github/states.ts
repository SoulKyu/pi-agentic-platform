import { randomBytes } from "node:crypto";
import type { Clock } from "../../kernel/clock.ts";
import { makeRoom } from "./per-user-cap.ts";

export const STATE_TTL_MS = 10 * 60_000;
const MAX_STATES = 64;

/** What a state is for: a state issued for one step is refused at any other. */
export type StatePurpose = "create" | "created" | "authorize";

export interface GithubStates {
  /** A new random state (32 hex) bound to `userId`, valid ten minutes. `data` rides with it (the origin the App is created on). */
  issue(userId: string, purpose?: StatePurpose, data?: string): string;
  /** True once: the state is known, unexpired, issued to `userId` (and for `purpose`, when given). An expired state is dropped; a foreign one is kept (it changes nothing). */
  consume(state: string, userId: string, purpose?: StatePurpose): boolean;
  /** Like `consume`, and hands back the data the state carries (null inside when it has none). */
  claim(state: string, userId: string, purpose: StatePurpose): { data: string | null } | null;
  /** Drops every pending state (the App was forgotten). */
  clear(): void;
  /** For a callback that arrives without a cookie: who started the flow and its data, once. Null for an unknown, expired, spent or other-purpose state. */
  take(state: string, purpose: StatePurpose): { userId: string; data: string | null } | null;
}

export function createStates(deps: { readonly clock: Clock }): GithubStates {
  const issued = new Map<
    string,
    { userId: string; until: number; purpose: StatePurpose; data: string | null }
  >();
  const sweep = (userId: string): void => {
    const now = deps.clock.now();
    for (const [key, entry] of issued) if (entry.until <= now) issued.delete(key);
    makeRoom(issued, (entry) => entry.userId, userId, MAX_STATES);
  };
  return {
    issue(userId, purpose = "create", data = undefined) {
      sweep(userId);
      const state = randomBytes(16).toString("hex");
      issued.set(state, { userId, until: deps.clock.now() + STATE_TTL_MS, purpose, data: data ?? null });
      return state;
    },
    claim(state, userId, purpose) {
      const entry = issued.get(state);
      if (!entry) return null;
      if (entry.until <= deps.clock.now()) {
        issued.delete(state);
        return null;
      }
      if (entry.userId !== userId || entry.purpose !== purpose) return null;
      issued.delete(state);
      return { data: entry.data };
    },
    consume(state, userId, purpose) {
      const entry = issued.get(state);
      if (!entry) return false;
      if (entry.until <= deps.clock.now()) {
        issued.delete(state);
        return false;
      }
      if (entry.userId !== userId || (purpose !== undefined && entry.purpose !== purpose)) return false;
      issued.delete(state);
      return true;
    },
    clear() {
      issued.clear();
    },
    take(state, purpose) {
      const entry = issued.get(state);
      if (!entry) return null;
      if (entry.until <= deps.clock.now()) {
        issued.delete(state);
        return null;
      }
      if (entry.purpose !== purpose) return null;
      issued.delete(state);
      return { userId: entry.userId, data: entry.data };
    },
  };
}
