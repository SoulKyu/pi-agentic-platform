import { PapError, PUSH_LIMITS } from "@pap/contracts";
import type { Clock } from "../../../kernel/clock.ts";
import type { PushPresence } from "../service.ts";

interface Entry {
  readonly ownerId: string;
  focused: boolean;
  at: number;
}

/**
 * Presence is a heartbeat (M12R11): an entry is one browser connection, fresh for 45 s. At 64 live entries a new
 * connection is refused with `capacity` after the expired ones are swept; nothing live is ever evicted (M12R9).
 */
export function createPresence(clock: Clock): PushPresence {
  const entries = new Map<string, Entry>();
  const fresh = (entry: Entry, now: number) => now - entry.at <= PUSH_LIMITS.presenceTtlMs;
  const sweep = (now: number) => {
    for (const [key, entry] of entries) if (!fresh(entry, now)) entries.delete(key);
  };
  return {
    report(ownerId, connectionId, focused) {
      const now = clock.now();
      const key = `${ownerId}\u0000${connectionId}`;
      const known = entries.get(key);
      if (!known) {
        if (entries.size >= PUSH_LIMITS.presenceEntries) sweep(now);
        if (entries.size >= PUSH_LIMITS.presenceEntries) throw new PapError("capacity");
        entries.set(key, { ownerId, focused, at: now });
        return;
      }
      known.focused = focused;
      known.at = now;
    },
    looking(ownerId) {
      const now = clock.now();
      for (const entry of entries.values())
        if (entry.ownerId === ownerId && entry.focused && fresh(entry, now)) return true;
      return false;
    },
  };
}
