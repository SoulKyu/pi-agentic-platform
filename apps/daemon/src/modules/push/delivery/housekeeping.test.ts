import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import { PUSH_MIGRATIONS } from "../index.ts";
import { createPushHousekeeping, purgePush } from "./housekeeping.ts";

const DAY = 86_400_000;
let bed: OutboxBed;
beforeEach(() => {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
});
afterEach(() => bed.close());

const event = (id: string, state: string, settledAt: number | null, cls = "failed") =>
  bed.db.run(
    `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at, settled_at)
     VALUES ($id, 'u1', $cls, 'session', $id, $id, $state, $created, $settled)`,
    { id, cls, state, created: settledAt ?? bed.clock.now() - 30 * DAY, settled: settledAt },
  );
const delivery = (eventId: string, state = "done") =>
  bed.db.run(
    "INSERT INTO push_deliveries (event_id, sub_id, state, attempts, next_at) VALUES ($eventId, 's', $state, 0, 0)",
    { eventId, state },
  );
const ids = () => bed.db.all<{ id: string }>("SELECT id FROM push_events ORDER BY id").map((r) => r.id);
const deliveryIds = () =>
  bed.db
    .all<{ event_id: string }>("SELECT event_id FROM push_deliveries ORDER BY event_id")
    .map((r) => r.event_id);

describe("housekeeping.purges-14-days", () => {
  it("removes old settled events and their deliveries; held and pending are kept", () => {
    const now = bed.clock.now();
    const old = now - 15 * DAY;
    const fresh = now - 13 * DAY;
    for (const state of ["sent", "failed", "suppressed", "cancelled", "digested"] as const) {
      event(`old-${state}`, state, old);
      delivery(`old-${state}`);
    }
    event("fresh-sent", "sent", fresh);
    delivery("fresh-sent");
    event("old-held", "held", null);
    event("old-pending", "pending", null);
    delivery("old-pending", "pending");
    bed.db.run(
      "INSERT INTO push_meta (key, value) VALUES ('digest:old-sent', '{}'), ('digest:fresh-sent', '{}')",
    );

    expect(purgePush(bed.db, now)).toBe(5);
    expect(ids()).toEqual(["fresh-sent", "old-held", "old-pending"]);
    expect(deliveryIds()).toEqual(["fresh-sent", "old-pending"]);
    expect(bed.db.all("SELECT key FROM push_meta ORDER BY key")).toEqual([{ key: "digest:fresh-sent" }]);
  });

  it("removes the leftover pending deliveries of a cancelled event, at any age, and orphans", () => {
    const now = bed.clock.now();
    event("cancelled-now", "cancelled", now - 1000);
    delivery("cancelled-now", "pending");
    event("live", "pending", null);
    delivery("live", "pending");
    delivery("ghost", "pending");
    purgePush(bed.db, now);
    expect(deliveryIds()).toEqual(["live"]);
    expect(ids()).toEqual(["cancelled-now", "live"]);
  });

  it("runs on the hourly cadence through the Clock and stops", async () => {
    const hk = createPushHousekeeping({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
    event("old", "sent", bed.clock.now() - 15 * DAY);
    hk.start();
    await bed.clock.advance(3_600_000 - 1);
    expect(ids()).toEqual(["old"]);
    await bed.clock.advance(1);
    expect(ids()).toEqual([]);
    hk.stop();
    event("old2", "sent", bed.clock.now() - 15 * DAY);
    await bed.clock.advance(7_200_000);
    expect(ids()).toEqual(["old2"]);
  });

  it("does nothing on a read-only database", async () => {
    const hk = createPushHousekeeping({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: true });
    event("old", "sent", bed.clock.now() - 15 * DAY);
    hk.start();
    await bed.clock.advance(7_200_000);
    expect(ids()).toEqual(["old"]);
  });
});
