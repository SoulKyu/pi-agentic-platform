import { AgentInput } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { draftFromInput, needsStepUp, toInput } from "./agent-form.vm.ts";

const draftOf = (patch: Record<string, unknown> = {}, input: AgentInput | null = null) => ({
  ...draftFromInput(input),
  name: "atlas",
  ...patch,
});
const saved = (patch: Record<string, unknown> = {}) => AgentInput.parse({ name: "atlas", ...patch });
const sources = (text: string) => {
  const built = toInput(draftOf({ trustedSources: text }));
  return built.ok ? built.input.trustedSources : built.errors;
};

describe("trusted sources in the form", () => {
  it("turns an internationalised name into its ASCII form", () => {
    expect(sources("Bücher.example")).toEqual(["xn--bcher-kva.example"]);
  });

  it("lower-cases, trims and drops empty lines", () => {
    expect(sources("  Docs.Example.COM \n\n api.example.com")).toEqual([
      "docs.example.com",
      "api.example.com",
    ]);
  });

  it.each([
    "https://x.example",
    "x.example/a",
    "*.x.example",
    "x.example:443",
    "user@x.example",
    "x.example?q",
    "%61.example",
    "a%2e.example",
  ])("refuses %s as typed, before URL parsing can rewrite it", (line) => {
    expect(sources(line)).toEqual({ trustedSources: "agentForm.error.trustedSources" });
  });

  it.each(["1.2.3", "0x7f.1"])(
    "refuses %s: the schema turns an address-like name down, whatever URL parsing makes of it",
    (line) => {
      expect(sources(line)).toEqual({ trustedSources: "agentForm.error.trustedSources" });
    },
  );

  it("keeps the fields on a round trip, so saving never turns autonomy off", () => {
    const before = saved({ trustedAutonomy: true, trustedSources: ["docs.example.com"] });
    const again = toInput(draftFromInput(before));
    expect(again.ok && again.input.trustedAutonomy).toBe(true);
    expect(again.ok && again.input.trustedSources).toEqual(["docs.example.com"]);
  });

  it("starts a new agent with autonomy off and no sources", () => {
    const draft = draftFromInput(null);
    expect(draft.trustedAutonomy).toBe(false);
    expect(draft.trustedSources).toBe("");
  });
});

describe("the step-up line follows widensReach (M11R94, W5-R36)", () => {
  const before = saved();
  it("asks when the switch goes on, not when it goes off", () => {
    expect(needsStepUp(before, draftOf({ trustedAutonomy: true }))).toBe(true);
    const on = saved({ trustedAutonomy: true });
    expect(needsStepUp(on, draftFromInput(on))).toBe(false);
    expect(needsStepUp(on, draftOf({ trustedAutonomy: false }, on))).toBe(false);
  });

  it("asks when a source is added, not when one is removed", () => {
    expect(needsStepUp(before, draftOf({ trustedSources: "docs.example.com" }))).toBe(true);
    const had = saved({ trustedSources: ["a.example.com", "b.example.com"] });
    expect(needsStepUp(had, draftOf({ trustedSources: "a.example.com" }, had))).toBe(false);
  });

  it("asks when the owner's list becomes a list of its own that reaches beyond it", () => {
    const own = saved({ allowHosts: null });
    const draft = draftOf({ ownHosts: false, hosts: "x.example.com" }, own);
    expect(needsStepUp(own, draft, ["y.example.com"])).toBe(true);
    expect(needsStepUp(own, draft, ["x.example.com"])).toBe(false);
    expect(needsStepUp(own, draft, null)).toBe(true);
  });
});
