import { describe, expect, it } from "vitest";
import { createRunGuard, GUARD_TITLES, guardTitle, MAX_COUNT } from "./run-guard.ts";

const limits = { identicalCalls: 3, toolCalls: 4, turns: 2 };

describe("the run guard", () => {
  it("trips on the 3rd identical top-level call in a row, not on nested ones, and a different call resets the streak", () => {
    const g = createRunGuard();
    // The brief's shared limits stop the 5th top-level call on tool-calls; this case is about the streak.
    const roomy = { ...limits, toolCalls: 10 };
    const step = (key: string, top = true) => {
      const verdict = g.check(key, top, roomy);
      g.commit(key, top);
      return verdict.outcome === "trip" ? verdict.rule : "pass";
    };
    expect([step("a"), step("a"), step("a", false), step("b"), step("a"), step("a")]).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    g.onRunStart();
    expect([step("x"), step("x"), step("x")]).toEqual(["pass", "pass", "identical-calls"]);
  });

  it("trips on the call past the limit and after the last allowed turn, and restarts a released counter", () => {
    const g = createRunGuard();
    for (const key of ["a", "b", "c", "d"]) {
      expect(g.check(key, true, limits).outcome).toBe("pass");
      g.commit(key, true);
    }
    expect(g.check("e", true, limits)).toMatchObject({ outcome: "trip", rule: "tool-calls" });
    g.release("tool-calls");
    expect(g.check("e", true, limits).outcome).toBe("pass");
    g.onTurn();
    g.onTurn();
    expect(g.check("f", true, limits).outcome).toBe("pass");
    g.onTurn();
    expect(g.check("f", true, limits)).toMatchObject({ outcome: "trip", rule: "turns" });
    g.release("turns");
    expect(g.check("f", true, limits).outcome).toBe("pass");
    g.onRunStart();
    expect(g.check("f", true, limits).outcome).toBe("pass");
  });

  it("check does not count: asking twice gives the same answer", () => {
    const g = createRunGuard();
    for (let i = 0; i < 5; i++) expect(g.check("a", true, limits).outcome).toBe("pass");
  });

  it("a nested call neither counts nor breaks the streak", () => {
    const g = createRunGuard();
    for (const [key, top] of [
      ["a", true],
      ["z", false],
      ["a", true],
      ["z", false],
    ] as const)
      g.commit(key, top);
    expect(g.check("a", true, limits)).toMatchObject({ outcome: "trip", rule: "identical-calls" });
    const total = createRunGuard();
    for (let i = 0; i < 10; i++) total.commit("n", false);
    expect(total.check("m", true, limits).outcome).toBe("pass");
  });

  it("releasing the identical-calls rule starts a new streak, other counters stay", () => {
    const g = createRunGuard();
    const both = { identicalCalls: 3, toolCalls: 3, turns: 2 };
    g.commit("a", true);
    g.commit("a", true);
    g.release("identical-calls");
    expect(g.check("a", true, both).outcome).toBe("pass");
    g.commit("a", true);
    expect(g.check("a", true, both)).toMatchObject({ outcome: "trip", rule: "tool-calls" });
  });

  it("keeps the counters bounded", () => {
    const g = createRunGuard();
    for (let i = 0; i < MAX_COUNT + 10; i++) {
      g.onTurn();
      g.commit("x", true);
    }
    expect(g.counts()).toEqual({ calls: MAX_COUNT, turns: MAX_COUNT, streak: MAX_COUNT });
  });

  it("reasons and titles carry the limit only", () => {
    const g = createRunGuard();
    g.commit("secret-key-text", true);
    g.commit("secret-key-text", true);
    const verdict = g.check("secret-key-text", true, { ...limits, identicalCalls: 4 });
    expect(verdict).toEqual({ outcome: "pass" });
    const trip = g.check("secret-key-text", true, { ...limits, identicalCalls: 2 });
    expect(trip).toEqual({
      outcome: "trip",
      rule: "identical-calls",
      reason: "the same call 2 times in a row",
    });
    expect(GUARD_TITLES["identical-calls"](5)).toBe(
      "The agent repeated the same call 5 times in a row. Allow it once more?",
    );
    expect(GUARD_TITLES["tool-calls"](150)).toBe(
      "The agent has made 150 tool calls in this run. Allow one more?",
    );
    expect(GUARD_TITLES.turns(60)).toBe("The agent has taken 60 turns in this run. Allow this call?");
    expect(guardTitle("turns", { identicalCalls: 5, toolCalls: 150, turns: 7 })).toBe(GUARD_TITLES.turns(7));
  });
});
