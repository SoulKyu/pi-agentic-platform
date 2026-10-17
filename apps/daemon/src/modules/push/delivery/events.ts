import type { Db } from "../../../kernel/db/database.ts";

export interface NewEvent {
  readonly id: string;
  readonly ownerId: string;
  readonly cls: string;
  readonly refKind: string;
  readonly refId: string;
  readonly name: string | null;
  readonly dedupKey: string;
  readonly now: number;
}

/** Inserts a `pending` event; false when a live (`pending` or `held`) event holds the key (the partial unique index). */
export function insertEvent(db: Db, event: NewEvent): boolean {
  return (
    db.run(
      `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, name, dedup_key, state, created_at)
       VALUES ($id, $owner, $cls, $kind, $ref, $name, $key, 'pending', $now)
       ON CONFLICT DO NOTHING`,
      {
        id: event.id,
        owner: event.ownerId,
        cls: event.cls,
        kind: event.refKind,
        ref: event.refId,
        name: event.name,
        key: event.dedupKey,
        now: event.now,
      },
    ).changes === 1
  );
}

/** True while a `pending` or `held` event holds the key. */
export function liveEventExists(db: Db, dedupKey: string): boolean {
  return (
    db.get("SELECT 1 AS one FROM push_events WHERE dedup_key = $key AND state IN ('pending', 'held')", {
      key: dedupKey,
    }) !== undefined
  );
}

/** The id of the `pending` event for a key; a `held` event belongs to the digest (M12R17). */
export function liveEventByKey(db: Db, dedupKey: string): string | null {
  return (
    db.get<{ id: string }>("SELECT id FROM push_events WHERE dedup_key = $key AND state = 'pending'", {
      key: dedupKey,
    })?.id ?? null
  );
}

export function cancelPending(db: Db, id: string, reason: string, now: number): void {
  db.run(
    "UPDATE push_events SET state = 'cancelled', reason = $reason, settled_at = $now WHERE id = $id AND state = 'pending'",
    { id, reason, now },
  );
}

/** The owner's `sent` non-approval events since `since`: the hourly cap's count, from the table so it survives a restart. */
export function countSentSince(db: Db, ownerId: string, since: number): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM push_events
       WHERE owner_id = $owner AND state = 'sent' AND cls NOT IN ('approval', 'digest', 'test') AND settled_at >= $since`,
      { owner: ownerId, since },
    )?.n ?? 0
  );
}

export interface EventRow {
  readonly id: string;
  readonly ownerId: string;
  readonly cls: string;
  readonly refKind: string;
  readonly refId: string;
  readonly name: string | null;
  readonly dedupKey: string;
  readonly state: string;
  readonly rechecks: number;
}

const COLUMNS = `id, owner_id AS ownerId, cls, ref_kind AS refKind, ref_id AS refId, name, dedup_key AS dedupKey,
            state, rechecks`;

export function loadEvent(db: Db, id: string): EventRow | undefined {
  return db.get<EventRow>(`SELECT ${COLUMNS} FROM push_events WHERE id = $id`, { id });
}

/** The owner's `held` events, oldest first: what the digest of the end of the quiet window judges (M12R17). */
export function heldEvents(db: Db, ownerId: string): EventRow[] {
  return db.all<EventRow>(
    `SELECT ${COLUMNS} FROM push_events WHERE owner_id = $owner AND state = 'held' ORDER BY created_at, rowid`,
    { owner: ownerId },
  );
}

/** A held event ends in the digest (`digested`, the reason is the digest event's id) or is dropped (`cancelled`). */
export function settleHeld(
  db: Db,
  id: string,
  state: "digested" | "cancelled",
  reason: string,
  now: number,
): void {
  db.run(
    "UPDATE push_events SET state = $state, reason = $reason, settled_at = $now WHERE id = $id AND state = 'held'",
    { id, state, reason, now },
  );
}

/** Moves a `pending` event to its next state; any other state is left alone (a settled event never changes its word). */
export function settleEvent(
  db: Db,
  id: string,
  state: "sent" | "failed" | "cancelled" | "suppressed" | "held",
  reason: string | null,
  now: number,
): void {
  db.run(
    `UPDATE push_events SET state = $state, reason = $reason, settled_at = $settled
     WHERE id = $id AND state = 'pending'`,
    { id, state, reason, settled: state === "held" ? null : now },
  );
}

export function bumpRechecks(db: Db, id: string): void {
  db.run("UPDATE push_events SET rechecks = rechecks + 1 WHERE id = $id AND state = 'pending'", { id });
}

/** The owner's last delivery failure (key `last_failure:<ownerId>`, W6-R6), for `push.config.lastFailure` (M12-RT-31): a reason class, never a body or an endpoint. */
export function recordLastFailure(db: Db, ownerId: string, reason: string, now: number): void {
  db.run(
    `INSERT INTO push_meta (key, value) VALUES ($key, $value)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    { key: `last_failure:${ownerId}`, value: JSON.stringify({ at: now, reason }) },
  );
}

/** The next success wipes the owner's last failure (key `last_failure:<ownerId>`). */
export function clearLastFailure(db: Db, ownerId: string): void {
  db.run("DELETE FROM push_meta WHERE key = $key", { key: `last_failure:${ownerId}` });
}
