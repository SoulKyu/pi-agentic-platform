import { describe, expect, it } from "vitest";
import { createAgentOver } from "./budget.ts";

function over(
  budget: { usdPerDay: number | null; tokensPerDay: number | null } | null,
  spent = { usd: 1, tokens: 100 },
) {
  const zones: Array<string | null> = [];
  const check = createAgentOver({
    budgetOf: (ownerId, agentId) => (ownerId === "u1" && agentId === "a" ? budget : null),
    spend: { agentSpentToday: (_o, _a, zone) => (zones.push(zone), spent) },
    timeZone: () => "Europe/Paris",
  });
  return { check, zones };
}

describe("the agent's own budget (M11R74)", () => {
  it("is not reached without a budget, with both lines empty, or for an agent it cannot read", () => {
    expect(over(null).check("u1", "a")).toBe(false);
    expect(over({ usdPerDay: null, tokensPerDay: null }).check("u1", "a")).toBe(false);
    expect(over({ usdPerDay: 1, tokensPerDay: 1 }).check("u1", "other")).toBe(false);
  });

  it("is reached at the line, not before: dollars or tokens, whichever comes first", () => {
    expect(over({ usdPerDay: 1, tokensPerDay: null }).check("u1", "a")).toBe(true);
    expect(over({ usdPerDay: 1.01, tokensPerDay: null }).check("u1", "a")).toBe(false);
    expect(over({ usdPerDay: null, tokensPerDay: 100 }).check("u1", "a")).toBe(true);
    expect(over({ usdPerDay: null, tokensPerDay: 101 }).check("u1", "a")).toBe(false);
    expect(over({ usdPerDay: 5, tokensPerDay: 100 }).check("u1", "a")).toBe(true);
  });

  it("is reached before anything runs at 0, and reads the owner's day", () => {
    const { check, zones } = over({ usdPerDay: 0, tokensPerDay: null }, { usd: 0, tokens: 0 });
    expect(check("u1", "a")).toBe(true);
    expect(zones).toEqual(["Europe/Paris"]);
  });
});
