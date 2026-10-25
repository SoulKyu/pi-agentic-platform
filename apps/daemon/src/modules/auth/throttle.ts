import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";

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

/**
 * The three tables, each with the policy that fits it (M5R127). Password and session tables never forget a live
 * lockout; the passkey table may, because nothing behind it can be guessed and a spray must not lock the recovery path.
 */
export function createAuthThrottles(clock: Clock): {
  password: Throttle;
  session: Throttle;
  passkey: Throttle;
} {
  return {
    password: createThrottle(clock, { whenFull: "refuse" }),
    session: createThrottle(clock, { whenFull: "refuse" }),
    passkey: createThrottle(clock, { whenFull: "evict" }),
  };
}

const INVITE_MAX_KEYS = 10_000;

/**
 * The invitation throttle (RT-15): a table of its own, never the sign-in or setup one, so a spray of bad invitation
 * links from a shared address cannot delay the owner's password sign-in. Same backoff as the others, kept in
 * `invite_throttle`; when full it forgets the oldest failure (nothing behind it can be guessed: tokens are 256 bits).
 */
export function createInviteThrottle(db: Db, clock: Clock): Throttle {
  interface Row {
    failures: number;
    lastFailureAt: number;
    blockedUntil: number;
  }
  const read = (key: string): Row | undefined => {
    const row = db.get<Row>(
      "SELECT failures, last_failure_at AS lastFailureAt, blocked_until AS blockedUntil FROM invite_throttle WHERE key = $key",
      { key },
    );
    return row && clock.now() - row.lastFailureAt < RESET_AFTER_MS ? row : undefined;
  };
  return {
    retryAfterMs: (keys) => Math.max(0, ...keys.map((key) => (read(key)?.blockedUntil ?? 0) - clock.now())),
    fail(keys) {
      const now = clock.now();
      db.transaction(() => {
        db.run("DELETE FROM invite_throttle WHERE last_failure_at <= $cutoff", {
          cutoff: now - RESET_AFTER_MS,
        });
        for (const key of keys) {
          const failures = (read(key)?.failures ?? 0) + 1;
          db.run(
            "INSERT OR REPLACE INTO invite_throttle (key, failures, last_failure_at, blocked_until) VALUES ($key, $failures, $now, $blockedUntil)",
            { key, failures, now, blockedUntil: now + backoffMs(failures) },
          );
        }
        db.run(
          "DELETE FROM invite_throttle WHERE key IN (SELECT key FROM invite_throttle ORDER BY last_failure_at DESC, rowid DESC LIMIT -1 OFFSET $max)",
          { max: INVITE_MAX_KEYS },
        );
      });
      return true;
    },
    succeed(keys) {
      for (const key of keys) db.run("DELETE FROM invite_throttle WHERE key = $key", { key });
    },
    size: () => db.get<{ c: number }>("SELECT count(*) AS c FROM invite_throttle")?.c ?? 0,
  };
}
