import type { AutomationSettings } from "@pap/contracts";
import type { Clock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { enqueueEffect, type Outbox, type Settlement } from "../../../kernel/outbox/index.ts";
import type { PushNotifier } from "../service.ts";
import { heldEvents, settleHeld, type EventRow } from "./events.ts";
import { nextQuietEnd } from "./quiet.ts";

/** What the source says of a held event when the quiet window ends (M12R17). */
export type DigestVerdict = "waiting" | "gone" | "expired";

const MINUTE_MS = 60_000;
const DONE: Settlement = { outcome: "done" };

/**
 * Queues the digest of a quiet window (M12R17). Called in the transaction that settles the event `held`, so a held
 * event never exists without its digest. The key `digest:<owner>:<endMinute>` makes it idempotent: a second held event
 * of the same night, or a replay, finds the row and writes nothing. A window that is already over (a replay a morning
 * later) digests at once.
 */
export function createDigestScheduler(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly outbox: Pick<Outbox, "poke">;
  readonly quietWindow: (ownerId: string) => {
    quietHours: AutomationSettings["quietHours"];
    timezone: string | null;
  };
}): (ownerId: string, at: number) => void {
  return (ownerId, at) => {
    const window = deps.quietWindow(ownerId);
    const end = nextQuietEnd(window.quietHours, window.timezone, at) ?? at;
    const endMinute = Math.floor(end / MINUTE_MS);
    const queued = enqueueEffect(
      deps.db,
      {
        kind: "digest.send",
        ownerId,
        payload: { ownerId, endMinute },
        dedupKey: `digest:${ownerId}:${endMinute}`,
        at: endMinute * MINUTE_MS,
      },
      deps.clock.now(),
    );
    // Null means the key exists (the only way `enqueueEffect` declines): the digest is already queued.
    if (queued !== null) deps.outbox.poke();
  };
}

export interface DigestDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notifier: Pick<PushNotifier, "notify">;
  /** Whether the thing a held event is about still waits, is gone, or timed out (M12R17); the source says, never the push. */
  readonly judge: (event: EventRow) => DigestVerdict;
}

/** What the digest event says: how many items wait and how many requests expired. Kept per digest event, not in a column. */
export function digestCounts(db: Db, eventId: string): { n: number; expired: number } {
  const raw = db.get<{ value: string }>("SELECT value FROM push_meta WHERE key = $key", {
    key: `digest:${eventId}`,
  })?.value;
  try {
    const parsed = JSON.parse(raw ?? "{}") as { n?: unknown; expired?: unknown };
    return {
      n: typeof parsed.n === "number" ? parsed.n : 0,
      expired: typeof parsed.expired === "number" ? parsed.expired : 0,
    };
  } catch {
    return { n: 0, expired: 0 };
  }
}

/**
 * The `digest.send` handler. It judges the owner's held events, then in ONE transaction creates the digest event (and
 * its `push.send`, so the per-device retries of task 9a apply), turns the counted events `digested` and drops the rest.
 * Nothing waits and nothing expired: no push. The digest is subject to mute and focus (decided by `push.send`), and
 * a digest that mute or focus suppresses is dropped, not re-queued: its items stay in the Inbox, the record. Never throws.
 */
export function createDigestSend(deps: DigestDeps) {
  return async (payload: { ownerId: string; endMinute: number }): Promise<Settlement> => {
    try {
      return run(deps, payload.ownerId);
    } catch (error) {
      deps.logger.error("digest_send_error", {
        errorClass: error instanceof Error ? error.name : typeof error,
      });
      return { outcome: "retry", code: "digest_error" };
    }
  };
}

function run(deps: DigestDeps, ownerId: string): Settlement {
  const { db } = deps;
  const now = deps.clock.now();
  const counted: EventRow[] = [];
  const expired: EventRow[] = [];
  const gone: EventRow[] = [];
  for (const event of heldEvents(db, ownerId)) {
    const verdict = deps.judge(event);
    (verdict === "waiting" ? counted : verdict === "expired" ? expired : gone).push(event);
  }
  if (counted.length === 0 && expired.length === 0) {
    db.transaction(() => {
      for (const event of gone) settleHeld(db, event.id, "cancelled", "gone", now);
    });
    return DONE;
  }
  return db.transaction((): Settlement => {
    // The notifier checks before it writes: a refusal (an earlier digest still being delivered) leaves nothing behind.
    const made = deps.notifier.notify({ ownerId, cls: "digest", refKind: "digest", refId: ownerId });
    if (made === null) return { outcome: "retry", code: "digest_busy" };
    db.run(
      `INSERT INTO push_meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      { key: `digest:${made.id}`, value: JSON.stringify({ n: counted.length, expired: expired.length }) },
    );
    for (const event of counted) settleHeld(db, event.id, "digested", made.id, now);
    for (const event of expired) settleHeld(db, event.id, "cancelled", "expired", now);
    for (const event of gone) settleHeld(db, event.id, "cancelled", "gone", now);
    return DONE;
  });
}
