import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import { cancelEffect, claimEffect, effectView, enqueueEffect, markSent, settleEffect } from "./store.ts";

let bed: OutboxBed;
beforeEach(() => {
  bed = openOutboxBed();
});
afterEach(() => bed.close());

const now = () => bed.clock.now();
const enqueue = () =>
  enqueueEffect(
    bed.db,
    { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "t1" }, dedupKey: "k1" },
    now(),
  ) as number;

describe("effectView", () => {
  it("is null for an unknown receipt", () => {
    expect(effectView(bed.db, "nope")).toBeNull();
  });

  it("follows the effect: pending, leased with the point of no return, done", () => {
    const id = enqueue();
    expect(effectView(bed.db, "k1")).toMatchObject({ status: "pending", sent: false, cancelled: false });
    claimEffect(bed.db, id, "feed.poll", now());
    expect(effectView(bed.db, "k1")).toMatchObject({ status: "leased", sent: false });
    markSent(bed.db, id, now());
    expect(effectView(bed.db, "k1")).toMatchObject({ status: "leased", sent: true });
    settleEffect(bed.db, id, { outcome: "done" }, now());
    expect(effectView(bed.db, "k1")).toMatchObject({ status: "done", cancelled: false });
  });

  it("reads a cancel of a pending effect and the mark on a leased one as cancelled", () => {
    enqueue();
    cancelEffect(bed.db, "k1", now());
    expect(effectView(bed.db, "k1")).toMatchObject({ status: "retired", cancelled: true });
    bed.db.run("DELETE FROM outbox");
    const id = enqueue();
    claimEffect(bed.db, id, "feed.poll", now());
    expect(cancelEffect(bed.db, "k1", now())).toBe("marked");
    expect(effectView(bed.db, "k1")).toMatchObject({ status: "leased", cancelled: true });
  });
});
