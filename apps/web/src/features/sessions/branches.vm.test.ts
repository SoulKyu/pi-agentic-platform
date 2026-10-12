import { describe, expect, it } from "vitest";
import { branchChoicesFor } from "./branches.vm.ts";

const choice = (entryId: string, target: string, onPath = false) => ({
  entryId,
  preview: `${entryId} try`,
  target,
  timestamp: null,
  onPath,
});
const points = [
  { parentId: "a0", choices: [choice("u1", "a1"), choice("u2", "a2", true), choice("u3", "a3")] },
];

describe("branchChoicesFor", () => {
  it("places a row among its siblings and names the neighbours' targets", () => {
    expect(branchChoicesFor(points, "u2")).toEqual({ index: 2, total: 3, previous: "a1", next: "a3" });
    expect(branchChoicesFor(points, "u1")).toEqual({ index: 1, total: 3, next: "a2" });
    expect(branchChoicesFor(points, "u3")).toEqual({ index: 3, total: 3, previous: "a2" });
    expect(branchChoicesFor(points, "u9")).toBeNull();
  });

  it("finds a row in any fork point and ignores a lone choice", () => {
    const more = [...points, { parentId: "b0", choices: [choice("v1", "b1"), choice("v2", "b2")] }];
    expect(branchChoicesFor(more, "v2")).toEqual({ index: 2, total: 2, previous: "b1" });
    expect(branchChoicesFor([{ parentId: "c0", choices: [choice("w1", "c1")] }], "w1")).toBeNull();
    expect(branchChoicesFor([], "u1")).toBeNull();
  });
});
