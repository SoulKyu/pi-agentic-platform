import { z } from "zod";

/** The daemon's `Db` (kernel/db/database.ts), as the outbox uses it. */
export interface OutboxDb {
  run(sql: string, params?: Record<string, string | number | null>): { changes: number };
  get<T>(sql: string, params?: Record<string, string | number | null>): T | undefined;
  all<T>(sql: string, params?: Record<string, string | number | null>): T[];
}

export type ReplayClass = "process-bound" | "replay-safe";

/**
 * Spec C §6.2. Process-bound: the effect acts on a process of this daemon's life (a worker, a run); after a crash it is
 * retired, never replayed. Replay-safe: doing it again after a crash is correct (a poll, a cleanup, a resume guarded by
 * its receipt and its sent mark). A kind is declared here once. Not here in M10 (ADR 0040): `run.abort` (Cancel aborts
 * directly after its commit; the boot kills every worker anyway) and M9's `lane.setup`, `checkpoint.capture`,
 * `worktree.cleanup` (M9's own rows, ADR 0035; moving them here is an M11 follow-up, agreement 15).
 */
export const REPLAY = {
  "task.start": "process-bound",
  "run.resume": "replay-safe",
  "feed.poll": "replay-safe",
  "attachment.cleanup": "replay-safe",
  // M12: a push is retried per target and a duplicate is collapsed by the push service (M12R13, M12R21).
  "push.send": "replay-safe",
  "digest.send": "replay-safe",
} as const satisfies Record<string, ReplayClass>;
export type EffectKind = keyof typeof REPLAY;

/**
 * How long a handler may work before its `signal` aborts (RT-06): at least its own bounded work. `task.start` waits for a
 * worker's `ready` (30 s) and a prompt; `run.resume` may wait on M9's `beforePrompt` (15 s, agreement 26); `feed.poll`
 * holds a fetch (10 s) and a precheck (30 s + 2 s + 2 s) with its queue wait.
 */
export const DEADLINE_MS = {
  "task.start": 90_000,
  "run.resume": 60_000,
  "feed.poll": 60_000,
  "attachment.cleanup": 30_000,
  "push.send": 30_000,
  "digest.send": 30_000,
} as const satisfies Record<EffectKind, number>;

const Id = z.string().min(1).max(128);
export const EFFECT_PAYLOADS = {
  "task.start": z.object({ taskId: Id }).strict(),
  "run.resume": z.object({ sessionId: Id, runId: Id, resetAt: z.number().int().nonnegative() }).strict(),
  "feed.poll": z.object({ triggerId: Id }).strict(),
  "attachment.cleanup": z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  "push.send": z.object({ eventId: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict(),
  "digest.send": z.object({ ownerId: Id, endMinute: z.number().int() }).strict(),
} satisfies { [K in EffectKind]: z.ZodType };
export type EffectPayload<K extends EffectKind> = z.infer<(typeof EFFECT_PAYLOADS)[K]>;

/** The row's lease: the kind's deadline plus 30 s. Informational: the boot never trusts it (every leased row is recovered). */
export const LEASE_SLACK_MS = 30_000;
export const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 600_000;
const RETENTION_MS = 7 * 86_400_000;

export interface EffectRow {
  readonly id: number;
  readonly kind: string;
  readonly replay: ReplayClass;
  readonly ownerId: string | null;
  readonly payload: string;
  readonly attempts: number;
}

/**
 * Writes an effect. Call it inside the transaction of the state change that implies it (C §6.2): this function opens
 * none. Returns the new id, or null when an effect with the same `dedupKey` exists (the receipt against duplicates).
 */
export function enqueueEffect<K extends EffectKind>(
  db: OutboxDb,
  effect: {
    readonly kind: K;
    readonly ownerId: string | null;
    readonly payload: EffectPayload<K>;
    readonly dedupKey?: string;
    readonly at?: number;
  },
  now: number,
): number | null {
  const payload = EFFECT_PAYLOADS[effect.kind].parse(effect.payload);
  const inserted = db.get<{ id: number }>(
    `INSERT INTO outbox (kind, replay, owner_id, payload, dedup_key, status, next_at, created_at)
     VALUES ($kind, $replay, $owner, $payload, $dedup, 'pending', $next, $now)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    {
      kind: effect.kind,
      replay: REPLAY[effect.kind],
      owner: effect.ownerId,
      payload: JSON.stringify(payload),
      dedup: effect.dedupKey ?? null,
      next: Math.max(now, effect.at ?? now),
      now,
    },
  );
  return inserted?.id ?? null;
}

/**
 * Boot, before anything else starts (C §6.3, T3 "parked roots"), never in read-only mode: a leased process-bound effect,
 * or a replay-safe one past its point of no return (`sent_at`), is retired; any other leased one is due again and the
 * boot counts that as an attempt, so an effect that crashes the daemon cannot run at every boot: at `MAX_ATTEMPTS` it
 * fails (counted in `failed`) instead of running again. Pending effects never ran and stay pending.
 */
export function recoverOutbox(
  db: OutboxDb,
  now: number,
): { retired: number; requeued: number; failed: number } {
  const retired = db.run(
    `UPDATE outbox SET status = 'retired', lease_until = NULL, settled_at = $now, last_error = 'crash'
     WHERE status = 'leased' AND (replay = 'process-bound' OR sent_at IS NOT NULL)`,
    { now },
  ).changes;
  const exhausted = db.run(
    `UPDATE outbox SET status = 'failed', attempts = attempts + 1, lease_until = NULL, settled_at = $now, last_error = 'crash'
     WHERE status = 'leased' AND replay = 'replay-safe' AND sent_at IS NULL AND attempts + 1 >= $max`,
    { now, max: MAX_ATTEMPTS },
  ).changes;
  const requeued = db.run(
    `UPDATE outbox SET status = 'pending', attempts = attempts + 1, lease_until = NULL, next_at = $now
     WHERE status = 'leased' AND replay = 'replay-safe' AND sent_at IS NULL`,
    { now },
  ).changes;
  return { retired, requeued, failed: exhausted };
}

/** Rows of a kind this binary does not declare (a newer or older pap wrote them): they are never run. */
export function countUnknownKinds(db: OutboxDb): number {
  return (
    db.get<{ n: number }>(
      `SELECT count(*) AS n FROM outbox WHERE status = 'pending' AND kind NOT IN (SELECT value FROM json_each($known))`,
      { known: JSON.stringify(Object.keys(REPLAY)) },
    )?.n ?? 0
  );
}

/**
 * The oldest due effect of a kind this daemon handles, not in flight and of no kind in flight (one handler per kind at
 * a time). Both filters are in the query, so rows of a kind this binary does not know never starve the ones it does.
 */
export function nextDue(
  db: OutboxDb,
  now: number,
  kinds: readonly string[],
  busyKinds: ReadonlySet<string>,
  inFlight: ReadonlySet<number>,
): EffectRow | null {
  return (
    db.get<EffectRow>(
      `SELECT id, kind, replay, owner_id AS ownerId, payload, attempts FROM outbox
       WHERE status = 'pending' AND next_at <= $now
         AND kind IN (SELECT value FROM json_each($kinds))
         AND kind NOT IN (SELECT value FROM json_each($busyKinds))
         AND id NOT IN (SELECT value FROM json_each($busy))
       ORDER BY next_at, id LIMIT 1`,
      {
        now,
        kinds: JSON.stringify(kinds),
        busyKinds: JSON.stringify([...busyKinds]),
        busy: JSON.stringify([...inFlight]),
      },
    ) ?? null
  );
}

/** When the loop should wake: the earliest pending row of a handled kind that is not busy; null when there is none. */
export function nextWakeAt(
  db: OutboxDb,
  kinds: readonly string[],
  busyKinds: ReadonlySet<string>,
): number | null {
  return (
    db.get<{ at: number | null }>(
      `SELECT min(next_at) AS at FROM outbox
       WHERE status = 'pending'
         AND kind IN (SELECT value FROM json_each($kinds))
         AND kind NOT IN (SELECT value FROM json_each($busyKinds))`,
      { kinds: JSON.stringify(kinds), busyKinds: JSON.stringify([...busyKinds]) },
    )?.at ?? null
  );
}

/** Takes the lease in one statement: false when someone else's state won (cancelled, already leased). */
export function claimEffect(db: OutboxDb, id: number, kind: EffectKind, now: number): boolean {
  return (
    db.run(
      `UPDATE outbox SET status = 'leased', lease_until = $until
       WHERE id = $id AND status = 'pending' AND next_at <= $now`,
      { id, until: now + DEADLINE_MS[kind] + LEASE_SLACK_MS, now },
    ).changes === 1
  );
}

/** The handler's point of no return (a resume about to prompt): from now on a crash retires the row. */
export function markSent(db: OutboxDb, id: number, now: number): boolean {
  return (
    db.run(`UPDATE outbox SET sent_at = $now WHERE id = $id AND status = 'leased'`, { id, now }).changes === 1
  );
}

/** Read by the handler right before its point of no return (RT-21): a cancel that came during the lease. */
export function cancelRequested(db: OutboxDb, id: number): boolean {
  return db.get<{ c: number }>(`SELECT cancel_requested AS c FROM outbox WHERE id = $id`, { id })?.c === 1;
}

export type Settlement =
  | { readonly outcome: "done" }
  | { readonly outcome: "defer"; readonly until: number }
  | { readonly outcome: "retry"; readonly code: string }
  | { readonly outcome: "fail"; readonly code: string };

/** Only a leased row moves; a deferral does not count as an attempt, a failure does (5 at most, then `failed`). */
export function settleEffect(db: OutboxDb, id: number, settlement: Settlement, now: number): void {
  // node:sqlite refuses a named parameter the statement does not use: each statement gets exactly its own.
  if (settlement.outcome === "done") {
    db.run(
      `UPDATE outbox SET status = 'done', lease_until = NULL, settled_at = $now WHERE id = $id AND status = 'leased'`,
      { id, now },
    );
    return;
  }
  if (settlement.outcome === "defer") {
    const moved = db.run(
      `UPDATE outbox SET status = 'pending', lease_until = NULL, next_at = $next
       WHERE id = $id AND status = 'leased' AND sent_at IS NULL`,
      { id, next: Math.max(settlement.until, now + 1_000) },
    ).changes;
    if (moved === 1) return;
  }
  // A deferral past the point of no return falls through and fails: the row is never run again.
  const code = settlement.outcome === "defer" ? "defer_after_send" : settlement.code.slice(0, 64);
  const row = db.get<{ attempts: number; sent: number | null }>(
    `SELECT attempts, sent_at AS sent FROM outbox WHERE id = $id AND status = 'leased'`,
    { id },
  );
  if (!row) return;
  const attempts = row.attempts + 1;
  // Past its point of no return an effect is never run again: a retry there is a failure.
  if (settlement.outcome === "fail" || attempts >= MAX_ATTEMPTS || row.sent !== null) {
    db.run(
      `UPDATE outbox SET status = 'failed', attempts = $attempts, lease_until = NULL, settled_at = $now, last_error = $code
       WHERE id = $id AND status = 'leased'`,
      { id, now, attempts, code },
    );
    return;
  }
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  db.run(
    `UPDATE outbox SET status = 'pending', attempts = $attempts, lease_until = NULL, next_at = $next, last_error = $code
     WHERE id = $id AND status = 'leased'`,
    { id, attempts, next: now + delay, code },
  );
}

/**
 * An effect nobody needs any more (a cancelled resume): a pending row is retired at once; a leased one gets the durable
 * cancel mark its handler reads before its point of no return (RT-21).
 */
export function cancelEffect(db: OutboxDb, dedupKey: string, now: number): "retired" | "marked" | "none" {
  if (
    db.run(
      `UPDATE outbox SET status = 'retired', settled_at = $now, last_error = 'cancelled'
       WHERE dedup_key = $key AND status = 'pending'`,
      { key: dedupKey, now },
    ).changes === 1
  )
    return "retired";
  return db.run(`UPDATE outbox SET cancel_requested = 1 WHERE dedup_key = $key AND status = 'leased'`, {
    key: dedupKey,
  }).changes === 1
    ? "marked"
    : "none";
}

export interface EffectView {
  readonly status: string;
  /** The point of no return was passed (`markSent`). */
  readonly sent: boolean;
  readonly cancelled: boolean;
  readonly nextAt: number;
}

/** What a receipt's effect is now, for a screen that shows "scheduled" or "cancelled"; null when there is none. */
export function effectView(db: OutboxDb, dedupKey: string): EffectView | null {
  const row = db.get<{
    status: string;
    sent: number | null;
    cancel: number;
    error: string | null;
    nextAt: number;
  }>(
    `SELECT status, sent_at AS sent, cancel_requested AS cancel, last_error AS error, next_at AS nextAt
     FROM outbox WHERE dedup_key = $key`,
    { key: dedupKey },
  );
  if (!row) return null;
  return {
    status: row.status,
    sent: row.sent !== null,
    cancelled: row.cancel === 1 || (row.status === "retired" && row.error === "cancelled"),
    nextAt: row.nextAt,
  };
}

/** The failures banner of one owner: their own failed effects and the system's, the 20 newest undismissed. */
export function listFailures(
  db: OutboxDb,
  ownerId: string,
  limit = 20,
): Array<{ id: number; kind: string; lastError: string | null; settledAt: number }> {
  return db.all(
    `SELECT id, kind, last_error AS lastError, settled_at AS settledAt FROM outbox
     WHERE status = 'failed' AND dismissed = 0 AND (owner_id = $owner OR owner_id IS NULL)
     ORDER BY settled_at DESC, id DESC LIMIT $limit`,
    { owner: ownerId, limit },
  );
}

/** The row as the failures banner shows it, once it is `failed`; undefined for any other state. */
export function failedRow(
  db: OutboxDb,
  id: number,
):
  | { id: number; kind: string; ownerId: string | null; lastError: string | null; settledAt: number }
  | undefined {
  return db.get(
    `SELECT id, kind, owner_id AS ownerId, last_error AS lastError, settled_at AS settledAt FROM outbox
     WHERE id = $id AND status = 'failed'`,
    { id },
  );
}

/** Another owner's failure answers false, like an unknown id. */
export function dismissFailure(db: OutboxDb, ownerId: string, id: number): boolean {
  return (
    db.run(
      `UPDATE outbox SET dismissed = 1 WHERE id = $id AND status = 'failed' AND dismissed = 0
       AND (owner_id = $owner OR owner_id IS NULL)`,
      { id, owner: ownerId },
    ).changes === 1
  );
}

/** C §3.4: settled rows go after 7 days; a failed row only once the owner dismissed it. */
export function purgeOutbox(db: OutboxDb, now: number): number {
  return db.run(
    `DELETE FROM outbox WHERE settled_at < $cutoff AND (status IN ('done', 'retired') OR (status = 'failed' AND dismissed = 1))`,
    { cutoff: now - RETENTION_MS },
  ).changes;
}
