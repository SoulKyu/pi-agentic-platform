import { randomBytes } from "node:crypto";
import { PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export const UNDO_TTL_MS = 60_000;
export const UNDO_MAX_PER_OWNER = 100;

export interface UndoRecord {
  readonly scope: "global" | "project";
  readonly name: string;
  /** The project folder of a project removal. */
  readonly cwd?: string;
  /** The entry as the file held it. It may carry literal secrets: it stays in this map and never reaches a client or a log. */
  readonly entry: string;
  readonly index: number;
}

interface Held {
  readonly owner: string;
  readonly record: UndoRecord;
  readonly expiresAt: number;
  readonly timer: TimerHandle;
}

/**
 * Removed MCP entries, kept in memory for one minute (M7R90). At most 100 per owner: when full a removal is refused
 * (`limit_reached`) before the file is touched, and nothing is evicted. A restart forgets them.
 */
export function createUndoStore(deps: { clock: Clock; newToken?: () => string }) {
  const held = new Map<string, Held>();
  const newToken = deps.newToken ?? (() => randomBytes(24).toString("base64url"));
  const purge = (): void => {
    const now = deps.clock.now();
    for (const [token, entry] of held) if (entry.expiresAt <= now) held.delete(token);
  };
  return {
    /** Records held right now, without purging: the timers alone must empty it. */
    size: () => held.size,
    /** Throws `limit_reached` when the owner already has 100 pending removals. */
    requireRoom(owner: string): void {
      purge();
      let count = 0;
      for (const entry of held.values()) if (entry.owner === owner) count += 1;
      if (count >= UNDO_MAX_PER_OWNER) throw new PapError("limit_reached");
    },
    put(owner: string, record: UndoRecord): { token: string; expiresInMs: number } {
      this.requireRoom(owner);
      const token = newToken();
      // The record forgets itself at expiry (MC44 M3): the clock's timers are unref'd, so none keeps the daemon alive.
      const timer = deps.clock.setTimeout(() => held.delete(token), UNDO_TTL_MS);
      held.set(token, { owner, record, expiresAt: deps.clock.now() + UNDO_TTL_MS, timer });
      return { token, expiresInMs: UNDO_TTL_MS };
    },
    /** Another owner's token is absent, like an expired or used one. */
    peek(owner: string, token: string): UndoRecord | undefined {
      purge();
      const entry = held.get(token);
      return entry?.owner === owner ? entry.record : undefined;
    },
    /** Taken once: a second undo with the same token finds nothing. */
    take(owner: string, token: string): UndoRecord | undefined {
      const record = this.peek(owner, token);
      const entry = held.get(token);
      if (record !== undefined && entry !== undefined) {
        deps.clock.clearTimeout(entry.timer);
        held.delete(token);
      }
      return record;
    },
  };
}
