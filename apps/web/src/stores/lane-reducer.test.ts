import { describe, expect, it } from "vitest";
import { fanoutView, laneSnapshot, laneView } from "../testing/lane-fixtures.ts";
import { EMPTY_LANES, isLiveLane, reduceLanes } from "./lane-reducer.ts";

const snap = reduceLanes(
  EMPTY_LANES,
  laneSnapshot(
    [laneView({ id: "a-1a2b" }), laneView({ id: "b-1a2b" })],
    [fanoutView({ id: "0".repeat(16) })],
    3,
  ),
);

describe("reduceLanes", () => {
  it("a snapshot replaces everything and marks the store loaded", () => {
    const next = reduceLanes(snap, laneSnapshot([laneView({ id: "c-1a2b" })], [], 1));
    expect([...next.lanes.keys()]).toEqual(["c-1a2b"]);
    expect([next.loaded, next.fanouts.size, next.archived]).toEqual([true, 0, 1]);
  });

  it("a lane event upserts", () => {
    const next = reduceLanes(snap, { kind: "lane", lane: laneView({ id: "a-1a2b", title: "renamed" }) });
    expect(next.lanes.get("a-1a2b")?.title).toBe("renamed");
    const added = reduceLanes(next, { kind: "lane", lane: laneView({ id: "z-1a2b" }) });
    expect(added.lanes.size).toBe(3);
  });

  it("an archived lane leaves the map and bumps the count once", () => {
    const archived = laneView({ id: "a-1a2b", state: "archived", archivedAt: 9 });
    const next = reduceLanes(snap, { kind: "lane", lane: archived });
    expect([...next.lanes.keys()]).toEqual(["b-1a2b"]);
    expect(next.archived).toBe(4);
    expect(reduceLanes(next, { kind: "lane", lane: archived }).archived).toBe(4);
  });

  it("an archiving lane stays held but is not live", () => {
    const next = reduceLanes(snap, { kind: "lane", lane: laneView({ id: "a-1a2b", state: "archiving" }) });
    expect(next.lanes.has("a-1a2b")).toBe(true);
    expect(isLiveLane(next.lanes.get("a-1a2b") as never)).toBe(false);
  });

  it("a fan-out event upserts", () => {
    const next = reduceLanes(snap, { kind: "fanout", fanout: fanoutView({ id: "f".repeat(16) }) });
    expect(next.fanouts.size).toBe(2);
  });

  it("an event this build cannot read is counted and skipped", () => {
    const next = reduceLanes(snap, { kind: "future", x: 1 });
    expect(next.skipped).toBe(1);
    expect(next.lanes).toBe(snap.lanes);
  });
});
