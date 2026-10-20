import { describe, expect, it } from "vitest";
import { createRelayPolicy } from "./policy.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-default-allow: an agent with no policy is allowed -> "an agent nobody told about" fails.
 *  - M-provider: match the model id alone -> "the provider is part of the pair" fails.
 *  - M-order: check `blocked` before the model -> "a wrong model is refused as model" fails.
 */
const policy = () => {
  const p = createRelayPolicy();
  p.set({
    agentId: "ag1",
    models: [
      { provider: "zai", id: "glm-4.6" },
      { provider: "openai", id: "gpt-5" },
    ],
    claude: false,
    blocked: null,
  });
  return p;
};

describe("createRelayPolicy", () => {
  it("allows a listed pair", () => {
    expect(policy().check("ag1", { provider: "zai", model: "glm-4.6" })).toEqual({ ok: true });
  });
  it("refuses an agent nobody told about (M-default-allow)", () => {
    expect(policy().check("ag2", { provider: "zai", model: "glm-4.6" })).toEqual({
      ok: false,
      reason: "model",
    });
  });
  it("the provider is part of the pair (M-provider)", () => {
    expect(policy().check("ag1", { provider: "openai", model: "glm-4.6" })).toEqual({
      ok: false,
      reason: "model",
    });
    expect(policy().check("ag1", { provider: "zai", model: "gpt-5" })).toEqual({
      ok: false,
      reason: "model",
    });
  });
  it("refuses a missing model and names an object would find", () => {
    expect(policy().check("ag1", { provider: "zai", model: null })).toEqual({ ok: false, reason: "model" });
    expect(policy().check("ag1", { provider: "__proto__", model: "constructor" })).toEqual({
      ok: false,
      reason: "model",
    });
    expect(policy().check("__proto__", { provider: "zai", model: "glm-4.6" })).toEqual({
      ok: false,
      reason: "model",
    });
  });
  it("lets the bridge in only when claude is true, with a claude model id", () => {
    const p = createRelayPolicy();
    p.set({ agentId: "ag1", models: [], claude: true, blocked: null });
    expect(p.check("ag1", { provider: null, model: "claude-sonnet-4-5" })).toEqual({ ok: true });
    expect(p.check("ag1", { provider: null, model: "claude-opus-4.1" })).toEqual({ ok: true });
    for (const model of [
      "gpt-5",
      "claude",
      "claude-",
      "Claude-x",
      "claude-" + "a".repeat(65),
      "claude-a b",
      null,
    ])
      expect(p.check("ag1", { provider: null, model }), String(model)).toEqual({
        ok: false,
        reason: "model",
      });
    p.set({ agentId: "ag1", models: [], claude: false, blocked: null });
    expect(p.check("ag1", { provider: null, model: "claude-sonnet-4-5" })).toEqual({
      ok: false,
      reason: "model",
    });
  });
  it("answers paused and budget after the model check (M-order)", () => {
    const p = policy();
    p.set({ agentId: "ag1", models: [{ provider: "zai", id: "glm-4.6" }], claude: false, blocked: "paused" });
    expect(p.check("ag1", { provider: "zai", model: "glm-4.6" })).toEqual({ ok: false, reason: "paused" });
    expect(p.check("ag1", { provider: "zai", model: "other" })).toEqual({ ok: false, reason: "model" });
    p.set({ agentId: "ag1", models: [{ provider: "zai", id: "glm-4.6" }], claude: false, blocked: "budget" });
    expect(p.check("ag1", { provider: "zai", model: "glm-4.6" })).toEqual({ ok: false, reason: "budget" });
  });
  it("a newer policy replaces the older one", () => {
    const p = policy();
    p.set({ agentId: "ag1", models: [], claude: false, blocked: null });
    expect(p.check("ag1", { provider: "zai", model: "glm-4.6" })).toEqual({ ok: false, reason: "model" });
  });
  it("is bounded: at most 4096 agents are kept, the oldest goes first", () => {
    const p = createRelayPolicy();
    for (let i = 0; i < 4097; i++)
      p.set({ agentId: `a${i}`, models: [{ provider: "zai", id: "m" }], claude: false, blocked: null });
    expect(p.check("a0", { provider: "zai", model: "m" })).toEqual({ ok: false, reason: "model" });
    expect(p.check("a4096", { provider: "zai", model: "m" })).toEqual({ ok: true });
  });
});
