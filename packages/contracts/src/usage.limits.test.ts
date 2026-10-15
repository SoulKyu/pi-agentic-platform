import { describe, expect, it } from "vitest";
import { methods } from "./methods.ts";
import { STREAMS } from "./streams.ts";
import { LimitView, UsageStreamEvent, USAGE_MAX_LIMITS, usageMethods } from "./usage.ts";

const limit = {
  sessionId: "s1",
  runId: "r1",
  resetAt: 1_000,
  resume: "scheduled",
  provider: "faux",
  model: "m",
};

describe("the usage stream and the limit methods (M10R106, M10R107)", () => {
  it("adds the stream and registers its three methods", () => {
    expect(STREAMS).toContain("usage");
    for (const name of ["subscribe.usage", "usage.resumeNow", "usage.cancelResume"] as const)
      expect(methods[name]).toBe(usageMethods[name]);
  });

  it("reads the stream with usage:read and operates with usage:operate, mutations needing a command id", () => {
    expect(usageMethods["subscribe.usage"]).toMatchObject({ permission: "usage:read", idempotent: true });
    for (const name of ["usage.resumeNow", "usage.cancelResume"] as const)
      expect(usageMethods[name]).toMatchObject({ permission: "usage:operate", idempotent: false });
  });

  it("takes a session id and nothing else (no owner from params)", () => {
    const { params } = usageMethods["usage.resumeNow"];
    expect(params.safeParse({ sessionId: "s1" }).success).toBe(true);
    expect(params.safeParse({ sessionId: "s1", ownerId: "u2" }).success).toBe(false);
    expect(usageMethods["subscribe.usage"].params.safeParse({ key: "u2" }).success).toBe(false);
  });

  it("accepts a limit with or without a reset and refuses an unknown resume state", () => {
    expect(LimitView.safeParse(limit).success).toBe(true);
    expect(LimitView.safeParse({ ...limit, resetAt: null, resume: "none" }).success).toBe(true);
    expect(LimitView.safeParse({ ...limit, resume: "later" }).success).toBe(false);
  });

  it("carries the four events, the snapshot capped at 200 limits", () => {
    const snapshot = { kind: "snapshot", limits: [limit], todayUsd: 1, budgetUsd: null, autoResume: true };
    expect(UsageStreamEvent.safeParse(snapshot).success).toBe(true);
    expect(UsageStreamEvent.safeParse({ kind: "limit", limit }).success).toBe(true);
    expect(UsageStreamEvent.safeParse({ kind: "limit_cleared", sessionId: "s1" }).success).toBe(true);
    expect(UsageStreamEvent.safeParse({ kind: "spend", todayUsd: 2, budgetUsd: 5 }).success).toBe(true);
    const many = Array.from({ length: USAGE_MAX_LIMITS + 1 }, () => limit);
    expect(UsageStreamEvent.safeParse({ ...snapshot, limits: many }).success).toBe(false);
  });
});
