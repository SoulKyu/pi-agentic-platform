import { describe, expect, it } from "vitest";
import { CALL_BUDGET, globMatch, PAIR_BUDGET, type StepBudget } from "./glob.ts";
import { CommandTooComplex } from "./shell-words.ts";

const spent = (pattern: string, text: string, ignoreCase = false) => {
  const budget: StepBudget = { left: PAIR_BUDGET };
  const matched = globMatch(pattern, text, { ignoreCase, budget });
  return { matched, steps: PAIR_BUDGET - budget.left };
};

describe("globMatch", () => {
  it("matches `*` against any run, spaces and the empty string included", () => {
    expect(spent("git *", "git push origin").matched).toBe(true);
    expect(spent("git*", "git").matched).toBe(true);
    expect(spent("*", "").matched).toBe(true);
  });

  it("matches `?` against exactly one character", () => {
    expect(spent("a?c", "abc").matched).toBe(true);
    expect(spent("a?c", "ac").matched).toBe(false);
    expect(spent("a?c", "abbc").matched).toBe(false);
  });

  it("is anchored on the whole text and treats everything else literally", () => {
    expect(spent("git push*", "x git push").matched).toBe(false);
    expect(spent("git push", "git push --force").matched).toBe(false);
    expect(spent("a.b[c]", "a.b[c]").matched).toBe(true);
    expect(spent("a.b", "axb").matched).toBe(false);
  });

  it("is case-sensitive unless told otherwise", () => {
    expect(spent("Remove-Item*", "remove-item x").matched).toBe(false);
    expect(spent("Remove-Item*", "remove-item x", true).matched).toBe(true);
  });

  it("spends the steps pinned by the prescribed matcher", () => {
    expect(spent("git push*", "git push --force-with-lease origin main")).toEqual({
      matched: true,
      steps: 40,
    });
    expect(spent("sudo *", "sudo apt update")).toEqual({ matched: true, steps: 16 });
    expect(spent("*aaaaaaaab", "a".repeat(1000))).toEqual({ matched: false, steps: 8937 });
  });

  it("throws past its budget and leaves the counter at -1", () => {
    const budget: StepBudget = { left: PAIR_BUDGET };
    expect(() => globMatch(`*${"a".repeat(64)}b`, "a".repeat(65_536), { ignoreCase: false, budget })).toThrow(
      CommandTooComplex,
    );
    expect(budget.left).toBe(-1);
  });

  it("charges two calls to one budget as the sum of their steps", () => {
    const budget: StepBudget = { left: CALL_BUDGET };
    globMatch("git push*", "git push --force-with-lease origin main", { ignoreCase: false, budget });
    globMatch("sudo *", "sudo apt update", { ignoreCase: false, budget });
    expect(CALL_BUDGET - budget.left).toBe(40 + 16);
  });
});
