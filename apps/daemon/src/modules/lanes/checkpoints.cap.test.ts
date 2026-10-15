import { LANE_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createCheckpointBed, LANE_ID, oid, REF } from "./testing/checkpoint-bed.ts";

function fullBed() {
  const bed = createCheckpointBed();
  for (let n = 0; n < LANE_LIMITS.checkpointsPerLane; n++) bed.refs.set(REF(`e/id${n}`), oid(n + 1));
  return bed;
}

describe("the checkpoint cap (M9R73)", () => {
  it("refuses a capture at the cap: refs untouched, checkpointsFull published, one notice however many refusals", async () => {
    const bed = fullBed();
    const kept = new Map(bed.refs);
    expect(bed.checkpoints.full(LANE_ID)).toBe(false);
    await bed.checkpoints.beforePrompt(bed.info({ leafId: "fresh" }), { value: false });
    await bed.checkpoints.beforePrompt(bed.info({ leafId: "fresh2" }), { value: false });
    bed.checkpoints.afterRun(bed.info({ leafId: "fresh3" }));
    await bed.checkpoints.settled();
    expect(bed.counters.captures).toBe(0);
    expect(bed.refs).toEqual(kept);
    expect(bed.checkpoints.full(LANE_ID)).toBe(true);
    expect(bed.changed).toContain(LANE_ID);
    expect(bed.notices.list(LANE_ID).map((notice) => notice.kind)).toEqual(["checkpoints_full"]);
  });

  it("still ends the run of a full lane: first_run_ended_at is set", async () => {
    const bed = fullBed();
    bed.checkpoints.afterRun(bed.info());
    await bed.checkpoints.settled();
    expect(bed.store.markFirstRunEnded).toHaveBeenCalledTimes(1);
  });

  it("captures below the cap", async () => {
    const bed = fullBed();
    bed.refs.delete(REF("e/id0"));
    bed.behaviour.leafId = "fresh";
    await bed.checkpoints.beforePrompt(bed.info({ leafId: "fresh" }), { value: false });
    expect(bed.refs.get(REF("e/fresh"))).toBe(oid(1));
    expect(bed.checkpoints.full(LANE_ID)).toBe(false);
  });

  it("forgets the flag when the lane is archived", async () => {
    const bed = fullBed();
    await bed.checkpoints.beforePrompt(bed.info(), { value: false });
    bed.checkpoints.forget(LANE_ID);
    expect(bed.checkpoints.full(LANE_ID)).toBe(false);
  });
});
