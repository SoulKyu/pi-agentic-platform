import { createHash } from "node:crypto";
import type { Db } from "../../kernel/db/database.ts";

/** Keys of entries kept per trigger; only the first 100 entries of a feed are read, so a dropped key is never met again. */
export const FEED_SEEN_MAX = 1_000;
/** The baseline row sorts after every real key, so the cut never drops it. */
const BASELINE_AT = Number.MAX_SAFE_INTEGER;

/** The row that says "the first poll of this address is done": a new address has another row, so it is a first poll again. */
const baselineOf = (url: string): string => createHash("sha256").update(`baseline:${url}`).digest("hex");

/** The keys among `keys` that were already turned into a task, or skipped at a first poll. */
export function seenKeys(db: Db, triggerId: string, keys: readonly string[]): Set<string> {
  const rows = db.all<{ entry: string }>(
    "SELECT entry FROM feed_seen WHERE trigger_id = $triggerId AND entry IN (SELECT value FROM json_each($keys))",
    { triggerId, keys: JSON.stringify(keys) },
  );
  return new Set(rows.map((row) => row.entry));
}

export function hasBaseline(db: Db, triggerId: string, url: string): boolean {
  return (
    db.get("SELECT 1 AS hit FROM feed_seen WHERE trigger_id = $triggerId AND entry = $entry", {
      triggerId,
      entry: baselineOf(url),
    }) !== undefined
  );
}

function insert(db: Db, triggerId: string, keys: readonly string[], at: number): void {
  db.run(
    `INSERT INTO feed_seen (trigger_id, entry, seen_at) SELECT $triggerId, value, $at FROM json_each($keys)
     WHERE true ON CONFLICT (trigger_id, entry) DO NOTHING`,
    { triggerId, keys: JSON.stringify(keys), at },
  );
}

/** Marks keys seen and keeps the newest 1 000. Call it in the transaction of the fire that used them. */
export function markSeen(db: Db, triggerId: string, keys: readonly string[], at: number): void {
  insert(db, triggerId, keys, at);
  db.run(
    `DELETE FROM feed_seen WHERE trigger_id = $triggerId AND seen_at < $baseline AND entry NOT IN (
       SELECT entry FROM feed_seen WHERE trigger_id = $triggerId AND seen_at < $baseline
       ORDER BY seen_at DESC, entry DESC LIMIT $max)`,
    { triggerId, baseline: BASELINE_AT, max: FEED_SEEN_MAX },
  );
}

/** The first poll of an address: whatever an older address left is dropped, every entry is marked, the baseline is set. */
export function takeBaseline(
  db: Db,
  triggerId: string,
  url: string,
  keys: readonly string[],
  at: number,
): void {
  db.run("DELETE FROM feed_seen WHERE trigger_id = $triggerId", { triggerId });
  markSeen(db, triggerId, keys, at);
  insert(db, triggerId, [baselineOf(url)], BASELINE_AT);
}
