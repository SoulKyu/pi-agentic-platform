import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateBed, createCreateBed } from "./testing/create-bed.ts";
import { insertLane } from "./testing/lane-rows.ts";

let bed: CreateBed | undefined;
afterEach(async () => {
  await bed?.service.shutdown();
  bed?.dispose();
  bed = undefined;
});
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : String(error)),
  );

describe("lanes for a member (M14)", () => {
  it("lanes.create on a host folder answers forbidden before any git or file-system work", async () => {
    bed = createCreateBed({ deps: { isMember: () => true } });
    expect(await codeOf(bed.service.create(bed.browser(), bed.params()))).toBe("forbidden");
    expect(bed.order).toEqual([]);
    expect(bed.db.all("SELECT id FROM lanes")).toEqual([]);
  });

  it("lanes.runScript answers forbidden before it reads the lane or starts a process", async () => {
    bed = createCreateBed({ deps: { isMember: () => true } });
    const lane = insertLane(bed.db);
    expect(await codeOf(bed.service.runScript(bed.browser(), { laneId: lane.id, kind: "test" }))).toBe(
      "forbidden",
    );
    expect(bed.fakes.children).toHaveLength(0);
  });
});
