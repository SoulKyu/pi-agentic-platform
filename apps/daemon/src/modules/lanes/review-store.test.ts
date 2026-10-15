import { afterEach, describe, expect, it } from "vitest";
import { createLanesBed, type LanesBed } from "./testing/bed.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { createReviewStore } from "./review-store.ts";

let bed: LanesBed;
afterEach(() => bed.dispose());

function setup() {
  bed = createLanesBed();
  insertLane(bed.db, { id: "lane-1", ownerId: "u1" });
  return createReviewStore(bed.db);
}

describe("lane_reviews compare-and-set (M9R78)", () => {
  it("answers nothing before the first write", () => {
    expect(setup().get("u1", "lane-1")).toBeUndefined();
  });

  it("inserts at revision 0 and updates at the current revision", () => {
    const store = setup();
    expect(store.put("u1", "lane-1", '{"seen":[],"comments":[]}', 0)).toBe(1);
    expect(store.put("u1", "lane-1", '{"seen":[],"comments":[1]}', 1)).toBe(2);
    expect(store.get("u1", "lane-1")).toEqual({ doc: '{"seen":[],"comments":[1]}', revision: 2 });
  });

  it("refuses a stale revision, and an insert over an existing row", () => {
    const store = setup();
    store.put("u1", "lane-1", "{}", 0);
    store.put("u1", "lane-1", "{}", 1);
    expect(store.put("u1", "lane-1", "{}", 1)).toBeNull();
    expect(store.put("u1", "lane-1", "{}", 0)).toBeNull();
    expect(store.get("u1", "lane-1")?.revision).toBe(2);
  });

  it("never shows or writes another owner's row", () => {
    const store = setup();
    store.put("u1", "lane-1", "{}", 0);
    expect(store.get("u2", "lane-1")).toBeUndefined();
    expect(store.put("u2", "lane-1", "{}", 1)).toBeNull();
    expect(store.get("u1", "lane-1")?.revision).toBe(1);
  });
});
