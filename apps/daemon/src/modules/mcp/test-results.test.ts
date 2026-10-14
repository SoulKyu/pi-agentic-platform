import type { McpTestResult } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createTestResults, TEST_RESULTS_MAX_PER_OWNER } from "./test-results.ts";

const result = (at: number): McpTestResult => ({
  state: "connected",
  tools: [],
  toolsTruncated: false,
  message: null,
  at,
});

describe("last Test results (M7R97)", () => {
  it("keeps one result per owner, scope and name, the latest replacing the earlier", () => {
    const results = createTestResults();
    expect(results.put("u1", "global", "a", undefined, result(1))).toBe(true);
    expect(results.put("u1", "global", "a", undefined, result(2))).toBe(true);
    expect(results.get("u1", "global", "a", undefined)?.at).toBe(2);
    expect(results.get("u1", "global", "b", undefined)).toBeUndefined();
    expect(results.get("u2", "global", "a", undefined)).toBeUndefined();
  });

  it("tells projects of the same server name apart", () => {
    const results = createTestResults();
    results.put("u1", "project", "a", "/w/one", result(1));
    results.put("u1", "project", "a", "/w/two", result(2));
    expect(results.get("u1", "project", "a", "/w/one")?.at).toBe(1);
    expect(results.get("u1", "project", "a", "/w/two")?.at).toBe(2);
    expect(results.get("u1", "global", "a", undefined)).toBeUndefined();
  });

  it("keeps at most 400 per owner: the 401st name is refused, a kept name is still replaced", () => {
    const results = createTestResults();
    for (let i = 0; i < TEST_RESULTS_MAX_PER_OWNER; i += 1)
      expect(results.put("u1", "global", `s${i}`, undefined, result(i))).toBe(true);
    expect(results.put("u1", "global", "extra", undefined, result(9))).toBe(false);
    expect(results.get("u1", "global", "extra", undefined)).toBeUndefined();
    expect(results.put("u1", "global", "s0", undefined, result(7))).toBe(true);
    expect(results.get("u1", "global", "s0", undefined)?.at).toBe(7);
    expect(results.put("u2", "global", "extra", undefined, result(1))).toBe(true);
  });

  it("forgets a result on drop, which frees its place", () => {
    const results = createTestResults();
    for (let i = 0; i < TEST_RESULTS_MAX_PER_OWNER; i += 1)
      results.put("u1", "global", `s${i}`, undefined, result(i));
    results.drop("u1", "global", "s3", undefined);
    expect(results.get("u1", "global", "s3", undefined)).toBeUndefined();
    expect(results.put("u1", "global", "extra", undefined, result(1))).toBe(true);
  });

  it("keeps the state and the count of tools, not the names", () => {
    const results = createTestResults();
    results.put("u1", "global", "a", undefined, {
      state: "connected",
      tools: ["x", "y", "z"],
      toolsTruncated: true,
      message: null,
      at: 4,
    });
    expect(results.get("u1", "global", "a", undefined)).toEqual({
      at: 4,
      state: "connected",
      count: 3,
      truncated: true,
    });
  });

  it("does not keep a result whose Test began before a removal (MC45 M2)", () => {
    const results = createTestResults();
    const began = results.epoch();
    results.drop("u1", "global", "other", undefined);
    expect(results.put("u1", "global", "a", undefined, result(1), began)).toBe(false);
    expect(results.get("u1", "global", "a", undefined)).toBeUndefined();
    expect(results.put("u1", "global", "a", undefined, result(2), results.epoch())).toBe(true);
  });
});
