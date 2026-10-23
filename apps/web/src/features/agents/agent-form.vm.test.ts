import { AgentInput } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  clearBudget,
  derivedInitials,
  draftFromInput,
  needsStepUp,
  toInput,
  type Draft,
} from "./agent-form.vm.ts";

const fresh = (patch: Partial<Draft> = {}): Draft => ({ ...draftFromInput(null), name: "atlas", ...patch });
const built = (draft: Draft): AgentInput => {
  const result = toInput(draft);
  if (!result.ok) throw new Error(`draft refused: ${JSON.stringify(result.errors)}`);
  return result.input;
};
/** A saved profile, as the Settings tab would hold it: `change` is what the person then edits. */
const edit = (saved: Partial<AgentInput>, change: Partial<Draft>) => {
  const before = AgentInput.parse({ name: "atlas", ...saved });
  return needsStepUp(before, { ...draftFromInput(before), ...change });
};

describe("agent form: defaults", () => {
  it("a new agent's draft builds exactly AgentInput.parse({ name }), with no budget", () => {
    const input = built(fresh());
    expect(input).toEqual(AgentInput.parse({ name: "atlas" }));
    expect(input.budget).toEqual({ usdPerDay: null, tokensPerDay: null });
  });

  it("holds no folder list: owner m7 gives an agent no extra home folder", () => {
    expect(Object.keys(fresh()).filter((key) => /folder|dir|home|path/i.test(key))).toEqual([]);
    expect(Object.keys(built(fresh()))).not.toContain("folders");
  });

  it("reads a saved profile back into the same input", () => {
    const saved = AgentInput.parse({
      name: "scout",
      initials: "SC",
      role: "Reads feeds.",
      model: { provider: "anthropic", modelId: "sonnet" },
      thinking: "high",
      mode: "supervised",
      preset: "read-only",
      sandbox: { required: false, network: true },
      allowHosts: ["a.example.com"],
      denylist: ["rm *"],
      budget: { usdPerDay: 2.5, tokensPerDay: 1000 },
      acceptsDelegation: true,
      memory: { capture: "off", save: "staged", hint: "likes tea", recallLimit: 3, recallThreshold: 0.5 },
    });
    expect(built(draftFromInput(saved))).toEqual(saved);
  });

  it("takes the name with or without its @, and the initials in capitals", () => {
    const input = built(fresh({ name: " @atlas ", initials: "at" }));
    expect(input.name).toBe("atlas");
    expect(input.initials).toBe("AT");
    expect(derivedInitials("@atlas-2")).toBe("AT");
  });
});

describe("agent form: what asks for the password (widensReach)", () => {
  it("a new agent at the defaults does not", () => {
    expect(needsStepUp(null, fresh())).toBe(false);
  });

  it("a new agent wider than the defaults does", () => {
    expect(needsStepUp(null, fresh({ network: true }))).toBe(true);
  });

  it("turning the network on, a higher mode, a higher preset or the full preset widens", () => {
    expect(edit({}, { network: true })).toBe(true);
    expect(edit({ mode: "read-only" }, { mode: "auto-accept-edits" })).toBe(true);
    expect(edit({ preset: "chat" }, { preset: "default" })).toBe(true);
    expect(edit({}, { preset: "full" })).toBe(true);
  });

  it("the way back does not", () => {
    expect(edit({ sandbox: { required: true, network: true } }, { network: false })).toBe(false);
    expect(edit({ mode: "auto-accept-edits" }, { mode: "read-only" })).toBe(false);
    expect(edit({ preset: "default" }, { preset: "chat" })).toBe(false);
    expect(edit({ preset: "full" }, { preset: "default" })).toBe(false);
  });

  it("adding a host to a list, or dropping the list for the owner's, widens; removing a host does not", () => {
    const listed = { allowHosts: ["a.example.com"] };
    expect(edit(listed, { hosts: "a.example.com\nb.example.com" })).toBe(true);
    expect(edit(listed, { ownHosts: true })).toBe(true);
    expect(edit({ allowHosts: ["a.example.com", "b.example.com"] }, { hosts: "a.example.com" })).toBe(false);
  });

  it("removing a blocked pattern widens; adding one does not", () => {
    expect(edit({ denylist: ["rm *", "dd *"] }, { denylist: "rm *" })).toBe(true);
    expect(edit({ denylist: ["rm *"] }, { denylist: "rm *\ndd *" })).toBe(false);
  });

  it("a draft the schema refuses asks for nothing: it cannot be saved", () => {
    expect(needsStepUp(null, fresh({ name: "two words", network: true }))).toBe(false);
  });
});

describe("agent form: the daily budget (owner m14)", () => {
  it("a typed budget is the number; emptied or Cleared it is null; neither asks for the password", () => {
    const typed = fresh({ usd: "2.5", tokens: "50000" });
    expect(built(typed).budget).toEqual({ usdPerDay: 2.5, tokensPerDay: 50000 });
    expect(built(fresh({ usd: "0" })).budget.usdPerDay).toBe(0);
    expect(built(fresh({ usd: "" })).budget.usdPerDay).toBeNull();
    const cleared = clearBudget(clearBudget(typed, "usd"), "tokens");
    expect(built(cleared).budget).toEqual({ usdPerDay: null, tokensPerDay: null });
    expect(edit({}, { usd: "3", tokens: "10" })).toBe(false);
    expect(edit({ budget: { usdPerDay: 3, tokensPerDay: 10 } }, { usd: "", tokens: "" })).toBe(false);
  });

  it("a negative or 1001 budget shows the schema's field error", () => {
    for (const usd of ["-1", "1001", "abc"]) {
      expect(toInput(fresh({ usd }))).toEqual({
        ok: false,
        errors: { "budget.usdPerDay": "agentForm.error.budget.usdPerDay" },
      });
    }
    expect(toInput(fresh({ tokens: "1.5" }))).toEqual({
      ok: false,
      errors: { "budget.tokensPerDay": "agentForm.error.budget.tokensPerDay" },
    });
  });
});

describe("agent form: the other fields speak the schema", () => {
  it("an invalid host shows the host field's error", () => {
    expect(toInput(fresh({ ownHosts: false, hosts: "api.example.com\nk8s.lan:0" }))).toEqual({
      ok: false,
      errors: { allowHosts: "agentForm.error.allowHosts" },
    });
  });

  it("an empty host list is a list: no host at all, not the owner's", () => {
    expect(built(fresh({ ownHosts: false, hosts: "" })).allowHosts).toEqual([]);
  });

  it("refuses a name that is not one word, and an out-of-range recall limit", () => {
    expect(toInput(fresh({ name: "two words" }))).toEqual({
      ok: false,
      errors: { name: "agentForm.error.name" },
    });
    expect(toInput(fresh({ memoryOn: true, recallLimit: "21", recallThreshold: "2" }))).toEqual({
      ok: false,
      errors: {
        "memory.recallLimit": "agentForm.error.memory.recallLimit",
        "memory.recallThreshold": "agentForm.error.memory.recallThreshold",
      },
    });
  });

  it("memory off is null; on keeps pi-mem0's terms and leaves empty numbers unset", () => {
    expect(built(fresh()).memory).toBeNull();
    expect(built(fresh({ memoryOn: true })).memory).toEqual({ capture: "auto", save: "direct" });
    expect(built(fresh({ memoryOn: true, save: "staged", recallLimit: "4" })).memory).toEqual({
      capture: "auto",
      save: "staged",
      recallLimit: 4,
    });
  });
});
