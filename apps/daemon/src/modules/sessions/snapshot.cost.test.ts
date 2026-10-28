import type { SessionCost } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { fitSnapshot, sizeOf } from "./snapshot.ts";

const cost: SessionCost = { sessionUsd: 0.42, runUsd: 0.05, billing: "api" };

describe("fitSnapshot and the cost", () => {
  it("fitSnapshot carries the cost it is given and counts it in the budget", () => {
    const base = fitSnapshot({ status: "idle", rows: [], dialogs: [] });
    expect(base.cost).toBeNull();
    const withCost = fitSnapshot({ status: "idle", rows: [], dialogs: [], cost });
    expect(withCost.cost).toEqual(cost);
    expect(sizeOf(withCost)).toBeGreaterThan(sizeOf(base));
  });
});
