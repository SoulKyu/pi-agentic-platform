import { describe, expect, it } from "vitest";
import { AGENT_LIMITS, AgentId, AgentInput, AgentName, AgentRole, widensReach } from "./index.ts";

const base = (extra: object = {}) => AgentInput.parse({ name: "Atlas", ...extra });
const widens = (before: object | null, after: object) =>
  widensReach(before === null ? null : base(before), base(after));

describe("AgentInput defaults and shape", () => {
  it("fills the defaults: sandbox required, network off, no budget, auto-accept-edits, default preset", () => {
    expect(base()).toEqual({
      name: "Atlas",
      trustedAutonomy: false,
      trustedSources: [],
      role: "",
      model: null,
      thinking: null,
      mode: "auto-accept-edits",
      preset: "default",
      sandbox: { required: true, network: false },
      allowHosts: null,
      denylist: [],
      budget: { usdPerDay: null, tokensPerDay: null },
      acceptsDelegation: false,
      memory: null,
      resources: { memoryMb: 1024, cpus: 1, diskMb: 4096 },
      systemPackages: [],
      packages: null,
    });
  });

  it("refuses a read-only folder list in the sandbox (owner m7) and any unknown key", () => {
    expect(AgentInput.safeParse({ name: "A", sandbox: { readOnly: ["~/docs"] } }).success).toBe(false);
    expect(AgentInput.safeParse({ name: "A", folders: [] }).success).toBe(false);
    expect(AgentInput.safeParse({ name: "A", memory: { capture: "auto", extra: 1 } }).success).toBe(false);
    expect(AgentInput.safeParse({ name: "A", budget: { usdPerDay: 1, per: 2 } }).success).toBe(false);
  });

  it("takes a budget, 0, and null to clear it; refuses negatives, over 1000, fractional tokens (owner m14)", () => {
    expect(base({ budget: { usdPerDay: 2.5, tokensPerDay: 100_000 } }).budget).toEqual({
      usdPerDay: 2.5,
      tokensPerDay: 100_000,
    });
    expect(base({ budget: { usdPerDay: 0, tokensPerDay: 0 } }).budget).toEqual({
      usdPerDay: 0,
      tokensPerDay: 0,
    });
    expect(base({ budget: { usdPerDay: null } }).budget).toEqual({ usdPerDay: null, tokensPerDay: null });
    for (const budget of [
      { usdPerDay: -1 },
      { usdPerDay: 1001 },
      { tokensPerDay: 1.5 },
      { tokensPerDay: -1 },
    ])
      expect(AgentInput.safeParse({ name: "A", budget }).success, JSON.stringify(budget)).toBe(false);
  });

  it("accepts a hosts list, even an empty one, and refuses an IP literal or a path", () => {
    expect(base({ allowHosts: [] }).allowHosts).toEqual([]);
    expect(base({ allowHosts: ["api.example.com", "*.example.org"] }).allowHosts).toHaveLength(2);
    expect(AgentInput.safeParse({ name: "A", allowHosts: ["10.0.0.1"] }).success).toBe(false);
    expect(AgentInput.safeParse({ name: "A", allowHosts: ["a.com/x"] }).success).toBe(false);
  });

  it("caps the lists", () => {
    const hosts = Array.from({ length: AGENT_LIMITS.hosts + 1 }, (_, n) => `h${n}.example.com`);
    expect(AgentInput.safeParse({ name: "A", allowHosts: hosts }).success).toBe(false);
    const patterns = Array.from({ length: AGENT_LIMITS.denyPatterns + 1 }, (_, n) => `rm ${n}`);
    expect(AgentInput.safeParse({ name: "A", denylist: patterns }).success).toBe(false);
  });

  it("checks the memory policy and the initials", () => {
    expect(base({ memory: {} }).memory).toEqual({ capture: "auto", save: "direct" });
    expect(AgentInput.safeParse({ name: "A", memory: { recallLimit: 21 } }).success).toBe(false);
    expect(AgentInput.safeParse({ name: "A", memory: { hint: "a\u202Eb" } }).success).toBe(false);
    expect(AgentInput.safeParse({ name: "A", initials: "abc" }).success).toBe(false);
    expect(base({ initials: "AT" }).initials).toBe("AT");
  });
});

describe("the model's text", () => {
  const model = (provider: string, modelId: string) =>
    AgentInput.safeParse({ name: "A", model: { provider, modelId } });

  it("takes visible text", () => {
    expect(model("anthropic", "claude-sonnet-4-5").success).toBe(true);
  });

  it.each(["a\u202Eb", "a\u200Bb", "a\u0000b", "a\u2028b", "a\nb", "a\tb"])(
    "refuses hidden text in either field (%j)",
    (text) => {
      expect(model(text, "ok").success).toBe(false);
      expect(model("ok", text).success).toBe(false);
    },
  );
});

describe("names and ids", () => {
  it("names are one word, letters first", () => {
    for (const name of ["Atlas", "a", "Scout_2", "my-bot"])
      expect(AgentName.safeParse(name).success, name).toBe(true);
    for (const name of ["", "2fast", "two words", "-x", "_x", "a".repeat(33), "Atlas\n", "Ata\u202Es"])
      expect(AgentName.safeParse(name).success, JSON.stringify(name)).toBe(false);
  });

  it("ids are <slug>-<4 hex>; `.runs`, `.trash` and traversals are not ids", () => {
    for (const id of ["atlas-1a2b", "my-bot-00ff", "a-0000"])
      expect(AgentId.safeParse(id).success, id).toBe(true);
    for (const id of [
      ".runs",
      ".trash",
      "../x-1a2b",
      "atlas",
      "atlas-1A2B",
      "atlas-12345",
      "-atlas-1a2b",
      "atlas/x-1a2b",
    ])
      expect(AgentId.safeParse(id).success, id).toBe(false);
  });

  it("a role keeps tabs and new lines and refuses other controls, bidi and zero-width characters", () => {
    expect(AgentRole.safeParse("line one\n\tline two").success).toBe(true);
    for (const text of [
      "a\u0000b",
      "a\rb",
      "a\u007Fb",
      "a\u0085b",
      "a\u202Eb",
      "a\u200Bb",
      "a\u2028b",
      "a\u2029b",
    ])
      expect(AgentRole.safeParse(text).success, JSON.stringify(text)).toBe(false);
    expect(AgentRole.safeParse("x".repeat(AGENT_LIMITS.roleChars + 1)).success).toBe(false);
  });
});

describe("widensReach (M11R44)", () => {
  it("creating with the defaults asks nothing; full-access or the full preset asks", () => {
    expect(widens(null, {})).toBe(false);
    expect(widens(null, { mode: "full-access" })).toBe(true);
    expect(widens(null, { preset: "full" })).toBe(true);
    expect(
      widens(null, { mode: "supervised", preset: "read-only", role: "x", budget: { usdPerDay: 1 } }),
    ).toBe(false);
  });

  it("a higher mode widens, a lower one narrows (RT-08)", () => {
    expect(widens({ mode: "read-only" }, { mode: "auto-accept-edits" })).toBe(true);
    expect(widens({ mode: "supervised" }, { mode: "auto-accept-edits" })).toBe(true);
    expect(widens({ mode: "auto-accept-edits" }, { mode: "full-access" })).toBe(true);
    expect(widens({ mode: "auto-accept-edits" }, { mode: "supervised" })).toBe(false);
    expect(widens({ mode: "full-access" }, { mode: "read-only" })).toBe(false);
  });

  it("a higher preset widens (none = chat < read-only < default < full = configured)", () => {
    expect(widens({ preset: "read-only" }, { preset: "default" })).toBe(true);
    expect(widens({ preset: "chat" }, { preset: "default" })).toBe(true);
    expect(widens({ preset: "none" }, { preset: "read-only" })).toBe(true);
    expect(widens({ preset: "default" }, { preset: "full" })).toBe(true);
    expect(widens({ preset: "default" }, { preset: "read-only" })).toBe(false);
    expect(widens({ preset: "full" }, { preset: "configured" })).toBe(false);
    expect(widens({ preset: "configured" }, { preset: "full" })).toBe(false);
    expect(widens({ preset: "chat" }, { preset: "none" })).toBe(false);
    expect(widens({ preset: "none" }, { preset: "chat" })).toBe(false);
  });

  it("the sandbox turned off or the network turned on widens; the reverse narrows", () => {
    expect(widens({}, { sandbox: { required: false } })).toBe(true);
    expect(widens({}, { sandbox: { network: true } })).toBe(true);
    expect(widens({ sandbox: { required: false } }, { sandbox: { required: true } })).toBe(false);
    expect(widens({ sandbox: { network: true } }, { sandbox: { network: false } })).toBe(false);
    expect(widens({ sandbox: { network: true } }, { sandbox: { network: true } })).toBe(false);
  });

  it("the hosts list: to null and a superset widen; a subset and null to a list narrow", () => {
    expect(widens({ allowHosts: ["a.com"] }, { allowHosts: null })).toBe(true);
    expect(widens({ allowHosts: ["a.com"] }, { allowHosts: ["a.com", "b.com"] })).toBe(true);
    expect(widens({ allowHosts: ["a.com", "b.com"] }, { allowHosts: ["a.com"] })).toBe(false);
    // W5-R36: from the owner's list to one of its own, judged against the owner's list (unknown here: widens).
    expect(widens({ allowHosts: null }, { allowHosts: ["a.com"] })).toBe(true);
    expect(widens({ allowHosts: [] }, { allowHosts: ["a.com"] })).toBe(true);
  });

  it("a blocked pattern removed widens, added narrows", () => {
    expect(widens({ denylist: ["rm *", "dd *"] }, { denylist: ["rm *"] })).toBe(true);
    expect(widens({ denylist: ["rm *"] }, { denylist: ["rm *", "dd *"] })).toBe(false);
  });

  it("a budget, delegation, memory, model, role and rename ask nothing", () => {
    expect(widens({}, { budget: { usdPerDay: 5 } })).toBe(false);
    expect(widens({ budget: { usdPerDay: 5 } }, { budget: { usdPerDay: 500 } })).toBe(false);
    expect(widens({ budget: { usdPerDay: 5 } }, { budget: { usdPerDay: null } })).toBe(false);
    expect(widens({}, { acceptsDelegation: true })).toBe(false);
    expect(widens({}, { memory: { capture: "off" } })).toBe(false);
    expect(
      widens({}, { model: { provider: "p", modelId: "m" }, thinking: "high", role: "new", name: "Atlas2" }),
    ).toBe(false);
  });

  it("an unreadable agent (null before) is compared with the defaults", () => {
    expect(widens(null, { mode: "supervised" })).toBe(false);
    expect(widens(null, { sandbox: { network: true } })).toBe(true);
  });
});
