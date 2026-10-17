import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import { PUSH_MIGRATIONS } from "../index.ts";
import { cancelPending, countSentSince, insertEvent, liveEventByKey } from "./events.ts";

let bed: OutboxBed;
beforeEach(() => {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
});
afterEach(() => bed.close());

const row = (id: string, key: string, over: Partial<Parameters<typeof insertEvent>[1]> = {}) => ({
  id,
  ownerId: "u1",
  cls: "failed",
  refKind: "inbox",
  refId: "i1",
  name: null,
  dedupKey: key,
  now: 1000,
  ...over,
});
const state = (id: string) =>
  bed.db.get<{ state: string; reason: string | null; settled_at: number | null }>(
    "SELECT state, reason, settled_at FROM push_events WHERE id = $id",
    { id },
  );

describe("events", () => {
  it("inserts pending and refuses a second live event for the key", () => {
    expect(insertEvent(bed.db, row("a", "k"))).toBe(true);
    expect(insertEvent(bed.db, row("b", "k"))).toBe(false);
    expect(state("a")?.state).toBe("pending");
    expect(state("b")).toBeUndefined();
  });

  it("allows a new event once the first is no longer live", () => {
    insertEvent(bed.db, row("a", "k"));
    bed.db.run("UPDATE push_events SET state = 'sent' WHERE id = 'a'");
    expect(insertEvent(bed.db, row("b", "k"))).toBe(true);
  });

  it("finds only a pending event by key", () => {
    insertEvent(bed.db, row("a", "k"));
    expect(liveEventByKey(bed.db, "k")).toBe("a");
    bed.db.run("UPDATE push_events SET state = 'held' WHERE id = 'a'");
    expect(liveEventByKey(bed.db, "k")).toBeNull();
  });

  it("cancels a pending event with its reason and time", () => {
    insertEvent(bed.db, row("a", "k"));
    cancelPending(bed.db, "a", "answered", 2000);
    expect(state("a")).toEqual({ state: "cancelled", reason: "answered", settled_at: 2000 });
  });

  it("counts an owner's sent non-approval events of the last hour", () => {
    const sent = (id: string, over: Partial<Parameters<typeof insertEvent>[1]>) => {
      insertEvent(bed.db, row(id, `k${id}`, over));
      bed.db.run("UPDATE push_events SET state = 'sent', settled_at = $at WHERE id = $id", {
        id,
        at: (over.now ?? 1000) as number,
      });
    };
    const HOUR = 3_600_000;
    sent("a", { now: HOUR + 10 });
    sent("b", { now: HOUR + 20, cls: "budget" });
    sent("c", { now: HOUR + 30, cls: "approval" });
    sent("d", { now: 5 }); // too old
    sent("e", { now: HOUR + 40, ownerId: "u2" });
    sent("g", { now: HOUR + 45, cls: "digest" });
    sent("h", { now: HOUR + 46, cls: "test" });
    insertEvent(bed.db, row("f", "kf", { now: HOUR + 50 })); // pending
    expect(countSentSince(bed.db, "u1", HOUR + 100 - HOUR)).toBe(2);
  });
});
