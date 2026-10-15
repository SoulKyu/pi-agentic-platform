import { describe, expect, it } from "vitest";
import { limitView, usageSnapshot } from "../testing/usage-bed.ts";
import { EMPTY_USAGE, reduceUsage } from "./usage-reducer.ts";

describe("reduceUsage", () => {
  it("starts empty and not loaded", () => {
    expect(EMPTY_USAGE).toMatchObject({ loaded: false, todayUsd: 0, budgetUsd: null, autoResume: true });
    expect(EMPTY_USAGE.limits.size).toBe(0);
  });

  it("takes the snapshot whole, replacing what it held", () => {
    const first = reduceUsage(EMPTY_USAGE, usageSnapshot([limitView({ sessionId: "a" })], { todayUsd: 1.5 }));
    expect(first).toMatchObject({ loaded: true, todayUsd: 1.5, budgetUsd: 5 });
    const second = reduceUsage(first, usageSnapshot([limitView({ sessionId: "b" })], { autoResume: false }));
    expect([...second.limits.keys()]).toEqual(["b"]);
    expect(second.autoResume).toBe(false);
  });

  it("adds or replaces a limit, and clears it when a later run started", () => {
    let view = reduceUsage(EMPTY_USAGE, usageSnapshot());
    view = reduceUsage(view, { kind: "limit", limit: limitView({ sessionId: "a" }) });
    view = reduceUsage(view, { kind: "limit", limit: limitView({ sessionId: "a", resume: "cancelled" }) });
    expect(view.limits.get("a")?.resume).toBe("cancelled");
    expect(view.limits.size).toBe(1);
    view = reduceUsage(view, { kind: "limit_cleared", sessionId: "a" });
    expect(view.limits.size).toBe(0);
  });

  it("follows the spend", () => {
    const view = reduceUsage(EMPTY_USAGE, { kind: "spend", todayUsd: 2, budgetUsd: null });
    expect(view).toMatchObject({ todayUsd: 2, budgetUsd: null });
  });

  it("keeps the 200 newest limits", () => {
    let view = reduceUsage(EMPTY_USAGE, usageSnapshot());
    for (let index = 0; index < 205; index++)
      view = reduceUsage(view, { kind: "limit", limit: limitView({ sessionId: `s${index}` }) });
    expect(view.limits.size).toBe(200);
    expect(view.limits.has("s0")).toBe(false);
    expect(view.limits.has("s204")).toBe(true);
  });

  it("ignores an event it does not know, and an unreadable snapshot leaves the view alone", () => {
    const view = reduceUsage(EMPTY_USAGE, usageSnapshot([limitView()]));
    expect(reduceUsage(view, { kind: "mystery" })).toBe(view);
    expect(reduceUsage(view, { kind: "snapshot", limits: "no" })).toBe(view);
    expect(reduceUsage(view, null)).toBe(view);
  });
});
