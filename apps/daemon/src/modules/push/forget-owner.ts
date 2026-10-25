import type { Db } from "../../kernel/db/database.ts";

/**
 * A deleted member's push rows (A5b): subscriptions, revoked endpoints, events and the deliveries of both. A delivery names an
 * event and a subscription, never an owner, so it goes through them first. Returns the subscriptions removed.
 */
export function forgetPushOwner(db: Db, ownerId: string): number {
  return db.transaction(() => {
    db.run(
      `DELETE FROM push_deliveries
        WHERE sub_id IN (SELECT id FROM push_subs WHERE owner_id = $ownerId)
           OR event_id IN (SELECT id FROM push_events WHERE owner_id = $ownerId)`,
      { ownerId },
    );
    db.run("DELETE FROM push_events WHERE owner_id = $ownerId", { ownerId });
    db.run("DELETE FROM push_revoked WHERE owner_id = $ownerId", { ownerId });
    return db.run("DELETE FROM push_subs WHERE owner_id = $ownerId", { ownerId }).changes;
  });
}
