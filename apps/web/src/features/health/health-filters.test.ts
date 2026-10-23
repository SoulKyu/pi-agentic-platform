// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, keeps, loadFilters, withSeverity } from "./health-filters.ts";

const event = {
  seq: 1,
  ts: 0,
  kind: "feed",
  severity: "err",
  code: "not_a_feed",
  sourceRef: { kind: "trigger", id: "t1", name: "K8s Blog" },
  count: 1,
} as const;

describe("health filters", () => {
  it("keeps by kind, severity and a case-insensitive search on code and source name", () => {
    expect(keeps(event, DEFAULT_FILTERS)).toBe(true);
    expect(keeps(event, { ...DEFAULT_FILTERS, kind: "sched" })).toBe(false);
    expect(keeps(event, { ...DEFAULT_FILTERS, severities: { err: false, att: true, mut: true } })).toBe(
      false,
    );
    expect(keeps(event, { ...DEFAULT_FILTERS, search: "k8s" })).toBe(true);
    expect(keeps(event, { ...DEFAULT_FILTERS, search: "deadline" })).toBe(false);
  });

  it("the last severity stays on", () => {
    expect(
      withSeverity({ ...DEFAULT_FILTERS, severities: { err: true, att: false, mut: false } }, "err", false)
        .severities.err,
    ).toBe(true);
  });

  it("falls back to the defaults on corrupted storage", () => {
    localStorage.setItem("pap.health.filters", "{oops");
    expect(loadFilters()).toEqual(DEFAULT_FILTERS);
  });
});
