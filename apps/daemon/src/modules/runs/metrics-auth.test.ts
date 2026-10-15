import { describe, expect, it } from "vitest";
import { METRICS_TOKEN, metricsAuthorized, topLabels } from "./metrics-auth.ts";

const TOKEN = "a".repeat(40);

describe("METRICS_TOKEN", () => {
  it("takes 32 to 256 characters of the base64url-ish set", () => {
    expect(METRICS_TOKEN.test("a".repeat(32))).toBe(true);
    expect(METRICS_TOKEN.test("aB3._~+/=-".repeat(4))).toBe(true);
    expect(METRICS_TOKEN.test("a".repeat(256))).toBe(true);
    expect(METRICS_TOKEN.test("a".repeat(31))).toBe(false);
    expect(METRICS_TOKEN.test("a".repeat(257))).toBe(false);
    expect(METRICS_TOKEN.test(`${"a".repeat(32)} `)).toBe(false);
    expect(METRICS_TOKEN.test(`${"a".repeat(32)}\n`)).toBe(false);
    expect(METRICS_TOKEN.test(`${"a".repeat(31)}é`)).toBe(false);
  });
});

describe("metricsAuthorized", () => {
  it("accepts exactly the configured bearer", () => {
    expect(metricsAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["empty", ""],
    ["raw token", TOKEN],
    ["two spaces", `Bearer  ${TOKEN}`],
    ["a character appended", `Bearer ${TOKEN}x`],
    ["a prefix of it", `Bearer ${TOKEN.slice(0, -1)}`],
    ["Basic", `Basic ${TOKEN}`],
    ["lower-case scheme", `bearer ${TOKEN}`],
    ["a trailing newline", `Bearer ${TOKEN}\n`],
    ["a trailing space", `Bearer ${TOKEN} `],
    ["no token", "Bearer "],
    ["a different token", `Bearer ${"b".repeat(40)}`],
  ])("refuses %s", (_name, header) => {
    expect(metricsAuthorized(header, TOKEN)).toBe(false);
  });
});

describe("topLabels", () => {
  const weights = new Map([
    ["cheap", 1],
    ["dear", 9],
    ["mid-b", 5],
    ["mid-a", 5],
  ]);

  it("keeps the highest weights, ties by value, and reads the rest as other", () => {
    const label = topLabels(weights, 2);
    expect([label("dear"), label("mid-a"), label("mid-b"), label("cheap"), label("unseen")]).toEqual([
      "dear",
      "mid-a",
      "other",
      "other",
      "other",
    ]);
  });

  it("gives the same answer whatever the order of the map", () => {
    const reversed = new Map([...weights].reverse());
    const names = ["dear", "mid-a", "mid-b", "cheap"];
    expect(names.map(topLabels(reversed, 3))).toEqual(names.map(topLabels(weights, 3)));
  });
});
