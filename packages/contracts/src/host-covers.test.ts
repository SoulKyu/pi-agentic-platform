import { describe, expect, it } from "vitest";
import { tryParseHostEntry } from "./host-entry.ts";
import { covers } from "./host-covers.ts";

const LEGACY = "not a host";

describe("covers", () => {
  it("a wildcard covers a narrower wildcard but never an exact entry (AVM2-E12)", () => {
    expect(covers(["*.x.com"], "*.a.x.com")).toBe(true);
    expect(covers(["*.x.com"], "a.x.com")).toBe(false);
  });

  it("the name-only fallback (a list holding an entry that is not a host entry) follows the same rule", () => {
    expect(tryParseHostEntry(LEGACY)).toBeNull();
    expect(covers([LEGACY, "*.x.com"], "a.x.com")).toBe(false);
    expect(covers([LEGACY, "*.x.com"], "*.a.x.com")).toBe(true);
    expect(covers([LEGACY, "a.x.com"], "a.x.com")).toBe(true);
  });
});
