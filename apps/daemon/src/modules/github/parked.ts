import { randomBytes } from "node:crypto";
import type { Clock } from "../../kernel/clock.ts";
import { makeRoom } from "./per-user-cap.ts";

export const PARKED_TTL_MS = 5 * 60_000;
const MAX_PARKED = 32;

export interface ParkedPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly refresh_token_expires_in: number;
}
export interface ParkedEntry {
  /** The pap user who started the sign-in: the only one whose session may finish it. */
  readonly userId: string;
  readonly origin: string;
  readonly pair: ParkedPair;
}

/** Tokens exchanged at the callback and not yet bound to a user: memory only, never logged, five minutes, once. */
export interface ParkedTokens {
  /** Parks the pair under a fresh 128-bit ticket (never derived from the state) and returns the ticket. */
  park(entry: ParkedEntry): string;
  /** Looks without consuming (a retry without a session); null for an unknown, expired or spent ticket. */
  peek(ticket: string): ParkedEntry | null;
  /** Hands the entry back once; null for an unknown, expired or spent ticket. */
  take(ticket: string): ParkedEntry | null;
  clear(): void;
}

export function createParked(deps: { readonly clock: Clock }): ParkedTokens {
  const parked = new Map<string, { entry: ParkedEntry; until: number }>();
  return {
    park(entry) {
      const now = deps.clock.now();
      for (const [key, one] of parked) if (one.until <= now) parked.delete(key);
      makeRoom(parked, (one) => one.entry.userId, entry.userId, MAX_PARKED);
      const ticket = randomBytes(16).toString("hex");
      parked.set(ticket, { entry, until: now + PARKED_TTL_MS });
      return ticket;
    },
    peek(ticket) {
      const found = parked.get(ticket);
      return found && found.until > deps.clock.now() ? found.entry : null;
    },
    take(ticket) {
      const found = parked.get(ticket);
      parked.delete(ticket);
      return found && found.until > deps.clock.now() ? found.entry : null;
    },
    clear: () => parked.clear(),
  };
}
