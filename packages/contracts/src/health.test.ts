import { describe, expect, it } from "vitest";
import { methods } from "./methods.ts";
import { HEALTH_TABLE, healthSeverityOf, HealthEvent, OpsStreamEvent } from "./health.ts";

describe("the health contract", () => {
  it("declares both methods system:read and idempotent", () => {
    expect(methods["ops.events.list"]).toMatchObject({ permission: "system:read", idempotent: true });
    expect(methods["subscribe.ops"]).toMatchObject({ permission: "system:read", idempotent: true });
  });
  it("accepts every table code with its severity; feed_status_<n> matches, unknowns do not", () => {
    for (const row of HEALTH_TABLE) expect(healthSeverityOf(row.kind, row.code)).toBe(row.severity);
    expect(healthSeverityOf("feed", "feed_status_503")).toBe("err");
    expect(healthSeverityOf("feed", "feed_status_2x")).toBeNull();
    expect(healthSeverityOf("task", "nope")).toBeNull();
  });
  it("rejects an event whose severity contradicts the table", () => {
    const base = { seq: 1, ts: 0, kind: "sched", code: "missed", sourceRef: null, count: 1 };
    expect(HealthEvent.safeParse({ ...base, severity: "att" }).success).toBe(true);
    expect(HealthEvent.safeParse({ ...base, severity: "err" }).success).toBe(false);
  });
  it("parses a snapshot, an event and a collapse", () => {
    const event = {
      seq: 1,
      ts: 0,
      kind: "feed",
      severity: "err",
      code: "not_a_feed",
      sourceRef: { kind: "trigger", id: "t1", name: "k8s blog" },
      count: 2,
    };
    expect(OpsStreamEvent.safeParse({ kind: "snapshot", events: [event], hasMore: false }).success).toBe(
      true,
    );
    expect(OpsStreamEvent.safeParse({ kind: "event", event }).success).toBe(true);
    expect(OpsStreamEvent.safeParse({ kind: "collapse", seq: 1, ts: 9, count: 3 }).success).toBe(true);
  });
});
