import { describe, expect, it } from "vitest";
import { formatCost, formatDiffCounts, formatDuration } from "./format.ts";

describe("number formats (DESIGN.md §11)", () => {
  it("writes costs as $0.00", () => {
    expect([formatCost(0), formatCost(1.234), formatCost(0.005), formatCost(-1)]).toEqual([
      "$0.00",
      "$1.23",
      "$0.01",
      "$0.00",
    ]);
    expect([formatCost(Number.NaN), formatCost(Number.POSITIVE_INFINITY)]).toEqual(["$0.00", "$0.00"]);
  });
  it("writes durations as 00:07 under a minute, 3m40 above, 1h05 above an hour", () => {
    expect([
      formatDuration(7_000),
      formatDuration(220_000),
      formatDuration(3_900_000),
      formatDuration(-5),
      formatDuration(Number.NaN),
    ]).toEqual(["00:07", "3m40", "1h05", "00:00", "00:00"]);
  });
  it("writes diff counts with a true minus sign", () => {
    expect(formatDiffCounts(214, 38)).toBe("+214 −38");
  });
});
