import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import { PUSH_MIGRATIONS } from "../index.ts";
import {
  dueDeliveries,
  earliestPending,
  hasDeliveries,
  insertDeliveries,
  retryDelivery,
  settleDelivery,
  summarize,
} from "./deliveries.ts";

let bed: OutboxBed;
beforeEach(() => {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
});
afterEach(() => bed.close());

describe("deliveries", () => {
  it("has none until inserted, then one pending row per subscription due now", () => {
    expect(hasDeliveries(bed.db, "e1")).toBe(false);
    insertDeliveries(bed.db, "e1", ["s1", "s2"], 100);
    expect(hasDeliveries(bed.db, "e1")).toBe(true);
    expect(dueDeliveries(bed.db, "e1", 100).map((d) => [d.subId, d.state, d.attempts])).toEqual([
      ["s1", "pending", 0],
      ["s2", "pending", 0],
    ]);
  });

  it("keeps events apart", () => {
    insertDeliveries(bed.db, "e1", ["s1"], 0);
    expect(hasDeliveries(bed.db, "e2")).toBe(false);
  });

  it("a retried row is not due before its next_at and is the earliest pending", () => {
    insertDeliveries(bed.db, "e1", ["s1", "s2"], 0);
    retryDelivery(bed.db, "e1", "s1", 1, 5_000);
    expect(dueDeliveries(bed.db, "e1", 4_999).map((d) => d.subId)).toEqual(["s2"]);
    settleDelivery(bed.db, "e1", "s2", "done", null);
    expect(earliestPending(bed.db, "e1")).toBe(5_000);
    expect(dueDeliveries(bed.db, "e1", 5_000).map((d) => [d.subId, d.attempts])).toEqual([["s1", 1]]);
  });

  it("has no earliest pending once every row is final", () => {
    insertDeliveries(bed.db, "e1", ["s1"], 0);
    settleDelivery(bed.db, "e1", "s1", "gone", "gone");
    expect(earliestPending(bed.db, "e1")).toBeNull();
  });

  it("settling twice keeps the first word", () => {
    insertDeliveries(bed.db, "e1", ["s1"], 0);
    settleDelivery(bed.db, "e1", "s1", "done", null);
    settleDelivery(bed.db, "e1", "s1", "failed", "rejected");
    expect(summarize(bed.db, "e1")).toEqual({ done: 1, failed: 0, gone: 0, firstFailure: null });
  });

  it("summarizes the first failure reason in insertion order", () => {
    insertDeliveries(bed.db, "e1", ["s1", "s2", "s3"], 0);
    settleDelivery(bed.db, "e1", "s1", "gone", "gone");
    settleDelivery(bed.db, "e1", "s2", "failed", "rejected");
    settleDelivery(bed.db, "e1", "s3", "failed", "retry_exhausted");
    expect(summarize(bed.db, "e1")).toEqual({ done: 0, failed: 2, gone: 1, firstFailure: "rejected" });
  });
});
