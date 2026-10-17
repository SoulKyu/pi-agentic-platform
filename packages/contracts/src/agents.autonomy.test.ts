import { describe, expect, it } from "vitest";
import { AgentInput, widensReach } from "./index.ts";

const base = (extra: object = {}) => AgentInput.parse({ name: "Atlas", ...extra });
const widens = (before: object | null, after: object, ownerHosts?: readonly string[] | null) =>
  widensReach(before === null ? null : base(before), base(after), ownerHosts);

describe("trustedAutonomy (owner a6)", () => {
  it("defaults to false", () => {
    expect(base().trustedAutonomy).toBe(false);
  });

  it("widens when it turns on, narrows when it turns off", () => {
    expect(widens({}, { trustedAutonomy: true })).toBe(true);
    expect(widens({ trustedAutonomy: true }, {})).toBe(false);
    expect(widens({ trustedAutonomy: true }, { trustedAutonomy: true })).toBe(false);
    expect(widens(null, { trustedAutonomy: true })).toBe(true);
  });

  it("widens when the hosts it covers grow while it is on", () => {
    const on = { trustedAutonomy: true };
    expect(
      widens({ ...on, allowHosts: ["a.example"] }, { ...on, allowHosts: ["a.example", "b.example"] }),
    ).toBe(true);
    expect(widens({ ...on, allowHosts: null }, { ...on, allowHosts: ["a.example"] }, null)).toBe(true);
    expect(widens({ ...on, allowHosts: ["a.example"] }, { ...on, allowHosts: ["a.example"] })).toBe(false);
    expect(
      widens({ ...on, allowHosts: ["a.example", "b.example"] }, { ...on, allowHosts: ["a.example"] }),
    ).toBe(false);
  });
});

describe("widensReach from no host list to the agent's own (W5-R36)", () => {
  const own = { allowHosts: ["a.example"] };
  it("does not widen when the owner's list reaches the host, exactly or by wildcard", () => {
    expect(widens({}, own, ["a.example"])).toBe(false);
    expect(widens({}, own, ["*.example"])).toBe(false);
  });
  it("widens when the owner's list does not reach a host", () => {
    expect(widens({}, own, ["b.example"])).toBe(true);
    expect(widens({}, { allowHosts: ["a.example", "x.test"] }, ["a.example"])).toBe(true);
  });
  it("widens when the owner has no list (null): the proxy reads it as no host (W5-R64 I2)", () => {
    expect(widens({}, own, null)).toBe(true);
    expect(widens({}, { allowHosts: [] }, null)).toBe(false);
    expect(widens({}, { allowHosts: null }, null)).toBe(false);
  });
  it("widens a non-empty list when the owner's list is not known, never an empty one", () => {
    expect(widens({}, own, undefined)).toBe(true);
    expect(widens({}, own)).toBe(true);
    expect(widens({}, { allowHosts: [] }, undefined)).toBe(false);
    expect(widens({}, { allowHosts: [] }, ["a.example"])).toBe(false);
  });
  it("keeps the existing rules: own list to null widens, a subdomain of a wildcard narrows", () => {
    expect(widens({ allowHosts: ["a.example"] }, { allowHosts: null }, null)).toBe(true);
    expect(widens({ allowHosts: ["*.x.example"] }, { allowHosts: ["a.x.example"] })).toBe(false);
    expect(widens({ allowHosts: ["a.x.example"] }, { allowHosts: ["*.x.example"] })).toBe(true);
  });
  it("never widens for a budget change", () => {
    expect(widens({}, { budget: { usdPerDay: 5, tokensPerDay: 100 } })).toBe(false);
  });
});

describe("trustedSources (owner a1)", () => {
  it("defaults to none and widens when a source is added", () => {
    expect(base().trustedSources).toEqual([]);
    expect(widens({}, { trustedSources: ["docs.example.com"] })).toBe(true);
    expect(widens(null, { trustedSources: ["docs.example.com"] })).toBe(true);
    expect(
      widens({ trustedSources: ["a.example.com"] }, { trustedSources: ["a.example.com", "b.example.com"] }),
    ).toBe(true);
  });
  it("does not widen when a source is removed or the list is reordered", () => {
    expect(
      widens({ trustedSources: ["a.example.com", "b.example.com"] }, { trustedSources: ["a.example.com"] }),
    ).toBe(false);
    expect(
      widens(
        { trustedSources: ["a.example.com", "b.example.com"] },
        { trustedSources: ["b.example.com", "a.example.com"] },
      ),
    ).toBe(false);
  });
  it("refuses 21 sources, a duplicate and a wildcard", () => {
    const many = Array.from({ length: 21 }, (_, index) => `h${index}.example.com`);
    expect(AgentInput.safeParse({ name: "Atlas", trustedSources: many }).success).toBe(false);
    expect(AgentInput.safeParse({ name: "Atlas", trustedSources: many.slice(0, 20) }).success).toBe(true);
    expect(
      AgentInput.safeParse({ name: "Atlas", trustedSources: ["a.example.com", "a.example.com"] }).success,
    ).toBe(false);
    expect(AgentInput.safeParse({ name: "Atlas", trustedSources: ["*.example.com"] }).success).toBe(false);
  });
});
