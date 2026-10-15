import { describe, expect, it } from "vitest";
import { classifyLimit } from "./limits.ts";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;

describe("classifyLimit", () => {
  const table: Array<[string, string, string, number | null]> = [
    [
      "Codex usage limit with a delay in minutes",
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~45 min.",
      "limited",
      NOW + 45 * MIN,
    ],
    ["insufficient_quota, no reset", "Error: insufficient_quota", "limited", null],
    [
      "a final rate limit with seconds",
      "rate_limit_error: slow down, retry after 30 seconds",
      "limited",
      NOW + 30_000,
    ],
    [
      "an absolute ISO instant",
      "Usage limit reached, resets at 2026-10-15T02:00:00Z",
      "limited",
      Date.UTC(2026, 9, 15, 2),
    ],
    ["hours and minutes", "Monthly usage limit reached. Resets in 3h 20m", "limited", NOW + 200 * MIN],
    ["hours only", "usage_limit: resets in 2h", "limited", NOW + 120 * MIN],
    ["a reset 9 days away is none", "usage limit, resets in 216h", "limited", null],
    ["a reset in the past is none", "usage limit, resets at 2026-10-14T11:00:00Z", "limited", null],
    ["a quota word in any case", "QUOTA EXCEEDED for this key", "limited", null],
    ["an invalid key", "Invalid API key", "failed", null],
    ["an empty text", "", "failed", null],
  ];
  it.each(table)("%s", (_name, text, kind, resetAt) => {
    expect(classifyLimit("error", text, NOW)).toEqual(
      kind === "limited" ? { kind: "limited", resetAt } : { kind: "failed" },
    );
  });

  it("never reads a run that did not end in error as limited", () => {
    expect(classifyLimit("stop", "usage limit reached", NOW)).toEqual({ kind: "failed" });
    expect(classifyLimit(null, "usage limit reached", NOW)).toEqual({ kind: "failed" });
  });

  it("reads no text at all as a plain failure", () => {
    expect(classifyLimit("error", null, NOW)).toEqual({ kind: "failed" });
  });

  it("answers a 1 MiB text within 50 ms (linear)", () => {
    const text = "a".repeat(1024 * 1024);
    const started = performance.now();
    expect(classifyLimit("error", text, NOW)).toEqual({ kind: "failed" });
    expect(classifyLimit("error", `${" ".repeat(1024 * 1024)}try again in ~`, NOW)).toEqual({
      kind: "failed",
    });
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("looks at the first 2 KiB only", () => {
    expect(classifyLimit("error", `${"a".repeat(2048)} usage limit`, NOW)).toEqual({ kind: "failed" });
  });
});
