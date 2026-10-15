import { LaneId, slugOf } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { BRANCH_TRIES, branchCandidates, laneIdOf } from "./names.ts";

describe("slugOf", () => {
  it("cleans a title into an ASCII slug", () => {
    expect(slugOf("Per-turn checkpoints!")).toBe("per-turn-checkpoints");
    expect(slugOf("Réparer l'été")).toBe("reparer-l-ete");
    expect(slugOf("日本語")).toBe("lane");
    expect(slugOf("x".repeat(100))).toBe("x".repeat(40));
  });
});

describe("laneIdOf", () => {
  it("is the slug, a dash and 4 hex digits, and matches LaneId", () => {
    for (const title of ["Per-turn checkpoints!", "日本語", "x".repeat(100), "a"]) {
      const id = laneIdOf(title);
      expect(LaneId.safeParse(id).success, id).toBe(true);
    }
    expect(laneIdOf("Fix 412", () => Buffer.from([0xab, 0xcd]))).toBe("fix-412-abcd");
  });

  it("draws different suffixes", () => {
    expect(new Set(Array.from({ length: 20 }, () => laneIdOf("same"))).size).toBeGreaterThan(1);
  });
});

describe("branchCandidates", () => {
  it("lists the prefixed slug, then -2 to -20, and no more", () => {
    const names = branchCandidates("pi/", "fix-412-high-memory");
    expect(names).toHaveLength(BRANCH_TRIES);
    expect(BRANCH_TRIES).toBe(20);
    expect(names[0]).toBe("pi/fix-412-high-memory");
    expect(names[1]).toBe("pi/fix-412-high-memory-2");
    expect(names[19]).toBe("pi/fix-412-high-memory-20");
  });
});
