import { AgentInput, MODEL_NOT_OFFERED, MODEL_PROVIDER_UNKNOWN, PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { type AgentLaunch, applyProfileModel, refusedModelNotice } from "./agent-gate.ts";

const launch: AgentLaunch = {
  agent: { id: "atlas-1a2b", name: "Atlas", role: "" },
  role: "thread",
  input: AgentInput.parse({ name: "Atlas", model: { provider: "claude-bridge", modelId: "claude-opus-4" } }),
};

/** What `applyProfileModel` reports when the worker answers `set_model` with `answer`. */
async function reported(answer: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>) {
  const reports: string[] = [];
  await applyProfileModel({ command: answer }, launch, (what, how) => void reports.push(`${what}:${how}`));
  return reports;
}

describe("the profile's model at start (review M6)", () => {
  it("is refused only on the worker's typed refusal; any other failure did not apply", async () => {
    expect(await reported(async () => ({ ok: true, data: null }))).toEqual([]);
    expect(await reported(async () => ({ ok: false, error: MODEL_NOT_OFFERED }))).toEqual(["model:refused"]);
    expect(await reported(async () => ({ ok: false, error: MODEL_PROVIDER_UNKNOWN }))).toEqual([
      "model:unknown-provider",
    ]);
    // Pi's own setModel failing its key check answers with Pi's words, not the refusal.
    expect(await reported(async () => ({ ok: false, error: "No API key for provider" }))).toEqual([
      "model:failed",
    ]);
    expect(
      await reported(async () => {
        throw new PapError("timeout");
      }),
    ).toEqual(["model:failed"]);
  });

  it("says what happened: not offered, not offered in Chat only, or could not be applied", () => {
    const saved = { provider: "claude-bridge", modelId: "claude-opus-4" };
    const running = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const code = (over: Partial<Parameters<typeof refusedModelNotice>[0]>) =>
      refusedModelNotice({ saved, running, how: "refused", chatOnly: false, ...over });
    expect(code({})).toMatchObject({
      code: "agent_model_refused",
      params: { model: "claude-bridge/claude-opus-4", running: "anthropic/claude-sonnet-4-5" },
    });
    expect(code({ running: null }).code).toBe("agent_model_refused_default");
    // Chat only is the reason only for a provider the worker lacks (an extension's, not loaded there): review N1.
    expect(code({ how: "unknown-provider", chatOnly: true })).toMatchObject({
      code: "agent_model_refused_chat",
      params: { model: "claude-bridge/claude-opus-4" },
    });
    expect(code({ chatOnly: true }).code).toBe("agent_model_refused");
    expect(code({ how: "unknown-provider" }).code).toBe("agent_model_refused");
    const failed = code({ how: "failed" });
    expect(failed.code).toBe("agent_model_not_applied");
    expect(failed.text).toContain("could not be applied");
    expect(failed.text).not.toContain("not offered");
  });

  it("clips a param to the 64 characters a coded sentence holds, and keeps the whole id in the text", () => {
    const long = { provider: "p", modelId: "m".repeat(100) };
    const notice = refusedModelNotice({ saved: long, running: null, how: "refused", chatOnly: false });
    expect(notice.params?.model).toHaveLength(64);
    expect(notice.text).toContain(`p/${"m".repeat(100)}`);
  });
});
