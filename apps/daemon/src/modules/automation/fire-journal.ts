import { AUTOMATION_LIMITS, type FireVerdict } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";
import { countFire } from "./fire-counts.ts";

export type { FireVerdict };

export interface JournalEntry {
  readonly triggerId: string;
  readonly ownerId: string;
  readonly source: string;
  readonly verdict: FireVerdict;
  readonly detail: string | null;
  readonly taskId: string | null;
  readonly dedupKey: string | null;
  readonly at: number;
}

/**
 * Writes one journal line (C §3.4). A refusal equal to the previous line of the trigger (same verdict, source and
 * detail) adds to its count; a `fired` line never collapses. The journal keeps the last 500 lines per trigger.
 * Call it inside the fire transaction.
 */
export function writeJournal(db: Db, entry: JournalEntry): void {
  countFire(db, entry.source, entry.verdict);
  const same =
    entry.verdict === "fired"
      ? undefined
      : db.get<{ id: number }>(
          `SELECT id FROM trigger_fires
           WHERE id = (SELECT max(id) FROM trigger_fires WHERE trigger_id = $triggerId)
             AND verdict = $verdict AND source = $source AND detail IS $detail AND dedup_key IS $dedupKey`,
          {
            triggerId: entry.triggerId,
            verdict: entry.verdict,
            source: entry.source,
            detail: entry.detail,
            dedupKey: entry.dedupKey,
          },
        );
  if (same) {
    db.run("UPDATE trigger_fires SET count = count + 1, last_at = $at WHERE id = $id", {
      id: same.id,
      at: entry.at,
    });
    return;
  }
  db.run(
    `INSERT INTO trigger_fires (trigger_id, owner_id, source, verdict, detail, task_id, dedup_key, count, first_at, last_at)
     VALUES ($triggerId, $ownerId, $source, $verdict, $detail, $taskId, $dedupKey, 1, $at, $at)`,
    {
      triggerId: entry.triggerId,
      ownerId: entry.ownerId,
      source: entry.source,
      verdict: entry.verdict,
      detail: entry.detail,
      taskId: entry.taskId,
      dedupKey: entry.dedupKey,
      at: entry.at,
    },
  );
  trimJournal(db, entry.triggerId, entry.at);
}

/** True when the key was `fired` on this trigger inside the window: the webhook dedup gate (M10R57), read in the fire transaction. */
export function firedWithin(db: Db, triggerId: string, key: string, windowMs: number, now: number): boolean {
  return (
    db.get(
      `SELECT 1 AS hit FROM trigger_fires
       WHERE trigger_id = $triggerId AND verdict = 'fired' AND dedup_key = $key AND last_at > $since LIMIT 1`,
      { triggerId, key, since: now - windowMs },
    ) !== undefined
  );
}

/**
 * Keeps the newest 500 lines of a trigger, and every `fired` line still inside the trigger's dedup window: a storm of
 * refusals must not push a fired line out and reopen the window (RT-17). Call it inside the writer's transaction.
 */
export function trimJournal(db: Db, triggerId: string, now: number): void {
  db.run(
    `DELETE FROM trigger_fires WHERE trigger_id = $triggerId
       AND id <= COALESCE((SELECT id FROM trigger_fires WHERE trigger_id = $triggerId ORDER BY id DESC LIMIT 1 OFFSET $keep), 0)
       AND NOT (verdict = 'fired' AND last_at >= $now - 60000 * COALESCE(
         (SELECT json_extract(config, '$.source.dedupMinutes') FROM triggers WHERE id = $triggerId), $window))`,
    {
      triggerId,
      keep: AUTOMATION_LIMITS.journalPerTrigger,
      now,
      window: AUTOMATION_LIMITS.dedupMinutes.fallback,
    },
  );
}

/** The housekeeping's cut: every trigger over its 500 lines. Returns how many triggers were cut. */
export function trimJournals(db: Db, now: number): number {
  const over = db.all<{ trigger_id: string }>(
    "SELECT trigger_id FROM trigger_fires GROUP BY trigger_id HAVING count(*) > $keep",
    { keep: AUTOMATION_LIMITS.journalPerTrigger },
  );
  for (const { trigger_id } of over) trimJournal(db, trigger_id, now);
  return over.length;
}
