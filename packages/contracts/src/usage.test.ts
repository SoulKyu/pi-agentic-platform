import { describe, expect, it } from "vitest";
import { methods } from "./methods.ts";
import { UsageSummary, usageMethods } from "./usage.ts";

const totals = { costUsd: 0.5, tokens: 1200, runs: 2 };

describe("usage.summary", () => {
  it("is a read of the usage domain, safe to repeat", () => {
    expect(usageMethods["usage.summary"]).toMatchObject({ permission: "usage:read", idempotent: true });
    expect(methods["usage.summary"]).toBe(usageMethods["usage.summary"]);
  });

  it("takes one of the three ranges and nothing else", () => {
    const { params } = usageMethods["usage.summary"];
    for (const range of ["today", "7d", "30d"]) expect(params.safeParse({ range }).success).toBe(true);
    for (const bad of [{ range: "1y" }, {}, { range: "today", ownerId: "u2" }])
      expect(params.safeParse(bad).success).toBe(false);
  });

  it("answers totals, one bucket per origin and per model", () => {
    const summary = {
      from: 1,
      to: 2,
      timeZone: "Europe/Paris",
      totals,
      byOrigin: [{ origin: "trigger", ...totals }],
      byModel: [{ provider: "anthropic", model: "claude", billing: "subscription", ...totals }],
      metrics: true,
      otlpHost: "otel.example.net:4318",
    };
    expect(UsageSummary.parse(summary)).toEqual(summary);
    expect(UsageSummary.parse({ ...summary, metrics: false, otlpHost: null }).otlpHost).toBeNull();
    expect(UsageSummary.safeParse({ ...summary, metrics: undefined }).success).toBe(false);
    expect(UsageSummary.safeParse({ ...summary, otlpHost: 4318 }).success).toBe(false);
    expect(UsageSummary.safeParse({ ...summary, totals: { ...totals, costUsd: -1 } }).success).toBe(false);
    expect(
      UsageSummary.safeParse({ ...summary, byModel: [{ ...summary.byModel[0], billing: "x" }] }).success,
    ).toBe(false);
  });
});
