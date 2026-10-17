import type { Db } from "../../../kernel/db/database.ts";

export interface DeliveryRow {
  readonly subId: string;
  readonly state: "pending" | "done" | "gone" | "failed";
  readonly attempts: number;
  readonly nextAt: number;
  readonly reason: string | null;
}

/** One row per event and subscription (M12R13); this is the state a replay resumes from. */
export function hasDeliveries(db: Db, eventId: string): boolean {
  return (
    db.get("SELECT 1 AS one FROM push_deliveries WHERE event_id = $eventId LIMIT 1", { eventId }) !==
    undefined
  );
}

export function insertDeliveries(db: Db, eventId: string, subIds: readonly string[], now: number): void {
  db.transaction(() => {
    for (const subId of subIds)
      db.run(
        `INSERT INTO push_deliveries (event_id, sub_id, state, attempts, next_at) VALUES ($eventId, $subId, 'pending', 0, $now)
         ON CONFLICT DO NOTHING`,
        { eventId, subId, now },
      );
  });
}

export function dueDeliveries(db: Db, eventId: string, now: number): DeliveryRow[] {
  return db.all<DeliveryRow>(
    `SELECT sub_id AS subId, state, attempts, next_at AS nextAt, reason FROM push_deliveries
     WHERE event_id = $eventId AND state = 'pending' AND next_at <= $now ORDER BY rowid`,
    { eventId, now },
  );
}

/** When the next pending delivery is due; null once every delivery is final. */
export function earliestPending(db: Db, eventId: string): number | null {
  return (
    db.get<{ at: number | null }>(
      "SELECT min(next_at) AS at FROM push_deliveries WHERE event_id = $eventId AND state = 'pending'",
      { eventId },
    )?.at ?? null
  );
}

/** Only a pending delivery moves: the first word stays. */
export function settleDelivery(
  db: Db,
  eventId: string,
  subId: string,
  state: "done" | "gone" | "failed",
  reason: string | null,
): void {
  db.run(
    `UPDATE push_deliveries SET state = $state, reason = $reason
     WHERE event_id = $eventId AND sub_id = $subId AND state = 'pending'`,
    { eventId, subId, state, reason },
  );
}

export function retryDelivery(
  db: Db,
  eventId: string,
  subId: string,
  attempts: number,
  nextAt: number,
): void {
  db.run(
    `UPDATE push_deliveries SET attempts = $attempts, next_at = $nextAt
     WHERE event_id = $eventId AND sub_id = $subId AND state = 'pending'`,
    { eventId, subId, attempts, nextAt },
  );
}

/** What became of the targets, for the event's own word. `gone` rows are devices that left, not failures. */
export function summarize(
  db: Db,
  eventId: string,
): { done: number; failed: number; gone: number; firstFailure: string | null } {
  const rows = db.all<{ state: string; reason: string | null }>(
    "SELECT state, reason FROM push_deliveries WHERE event_id = $eventId ORDER BY rowid",
    { eventId },
  );
  const failed = rows.filter((row) => row.state === "failed");
  return {
    done: rows.filter((row) => row.state === "done").length,
    failed: failed.length,
    gone: rows.filter((row) => row.state === "gone").length,
    firstFailure: failed[0]?.reason ?? null,
  };
}
