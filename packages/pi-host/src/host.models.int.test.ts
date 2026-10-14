import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_BUSY } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRecord } from "./testing/fork-host.ts";
import { bashScript, createHostBed, isApproval } from "./testing/host-bed.ts";
import { writeExtension } from "./testing/extensions.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

const TWO_MODELS = {
  modelId: "plain",
  extraModels: [{ id: "thinker", reasoning: true }],
  steps: [{ text: "one" }, { text: "two" }],
};
const idsOf = (data: unknown) => (data as { models: Array<{ id: string }> }).models.map((model) => model.id);
const loadouts = (host: { records: HostRecord[] }) =>
  host.records
    .filter((record) => record.type === "loadout")
    .map((record) => record.loadout as { thinkingLevel: string; levels: string[] });

describe("models and reasoning over IPC (M7 Task 7)", () => {
  it("sends the loadout once the session is ready", async () => {
    await bed.start(TWO_MODELS);
    const host = bed.host();
    const record = await host.waitFor((r) => r.type === "loadout");
    expect(record.loadout).toMatchObject({
      model: { id: "plain", reasoning: false },
      thinkingLevel: "off",
      levels: ["off"],
      preset: "configured",
    });
    expect((record.loadout as { tools: string[] }).tools).toEqual(expect.arrayContaining(["bash", "read"]));
  });

  it("lists both models in the script's order and names the current one", async () => {
    await bed.start(TWO_MODELS);
    const answer = await bed.host().request({ type: "get_available_models" });
    expect(answer).toMatchObject({ success: true, data: { truncated: false } });
    expect(idsOf(answer.data)).toEqual(["plain", "thinker"]);
    expect((answer.data as { current: { id: string } }).current.id).toBe("plain");
  });

  it("switches the model for the session only: settings.json stays byte-identical", async () => {
    await bed.start(TWO_MODELS, { settings: { compaction: { keepRecentTokens: 4321 } } });
    const host = bed.host();
    const settings = join(bed.agentDir, "settings.json");
    const before = readFileSync(settings);
    const from = host.records.length;
    expect(await host.request({ type: "set_model", provider: "faux", modelId: "thinker" })).toMatchObject({
      success: true,
    });
    const listed = await host.request({ type: "get_available_models" });
    expect((listed.data as { current: { id: string } }).current.id).toBe("thinker");
    expect(loadouts({ records: host.records.slice(from) }).at(-1)).toMatchObject({
      model: { id: "thinker", reasoning: true },
    });
    expect(await host.request({ type: "set_thinking_level", level: "high" })).toMatchObject({
      success: true,
    });
    expect(readFileSync(settings).equals(before)).toBe(true);
  });

  it("refuses an unknown model and keeps the current one", async () => {
    await bed.start(TWO_MODELS);
    const host = bed.host();
    expect(await host.request({ type: "set_model", provider: "faux", modelId: "nope" })).toMatchObject({
      success: false,
    });
    const listed = await host.request({ type: "get_available_models" });
    expect((listed.data as { current: { id: string } }).current.id).toBe("plain");
  });

  it("clamps a level the model lacks, and keeps a model without reasoning at off", async () => {
    await bed.start(TWO_MODELS);
    const host = bed.host();
    await host.request({ type: "set_thinking_level", level: "high" });
    expect(loadouts(host).at(-1)).toMatchObject({ thinkingLevel: "off", levels: ["off"] });
    await host.request({ type: "set_model", provider: "faux", modelId: "thinker" });
    await host.request({ type: "set_thinking_level", level: "xhigh" });
    const last = loadouts(host).at(-1);
    // The scripted reasoning model has no xhigh in its level map: Pi clamps to the nearest level it has.
    expect(last?.levels).not.toContain("xhigh");
    expect(last?.thinkingLevel).toBe("high");
  });

  it("scopes the list to enabledModels, resolved by Pi", async () => {
    await bed.start(TWO_MODELS, { settings: { enabledModels: ["thinker"] } });
    const answer = await bed.host().request({ type: "get_available_models" });
    expect(idsOf(answer.data)).toEqual(["thinker"]);
    expect(await bed.host().request({ type: "set_model", provider: "faux", modelId: "plain" })).toMatchObject(
      { success: false },
    );
  });

  it("lists a model an extension's provider registers", async () => {
    writeExtension(
      bed.agentDir,
      "provider",
      `export default function (pi) {
  pi.registerProvider("extprov", {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "not-a-real-key",
    api: "openai-completions",
    models: [{ id: "ext-model", name: "Ext model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  });
}
`,
    );
    await bed.start(TWO_MODELS);
    const answer = await bed.host().request({ type: "get_available_models" });
    const models = (answer.data as { models: Array<{ provider: string; id: string }> }).models;
    expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual(
      expect.arrayContaining(["faux/plain", "extprov/ext-model"]),
    );
  });

  it("tells the daemon when an extension switches the model and the level itself (M7R44)", async () => {
    writeExtension(
      bed.agentDir,
      "switcher",
      `export default function (pi) {
  pi.registerCommand("switch", {
    handler: async (_args, ctx) => {
      await pi.setModel(ctx.modelRegistry.find("faux", "thinker"));
      pi.setThinkingLevel("high");
    },
  });
}
`,
    );
    await bed.start(TWO_MODELS);
    const host = bed.host();
    const from = host.records.length;
    host.send({ type: "prompt", id: "p1", message: "/switch" });
    await host.waitFor(
      (r) =>
        r.type === "loadout" &&
        (r.loadout as { model?: { id: string }; thinkingLevel: string }).model?.id === "thinker" &&
        (r.loadout as { thinkingLevel: string }).thinkingLevel === "high",
      { from },
    );
  });

  it("refuses a model change while a run is parked on an approval, and allows a reasoning change", async () => {
    await bed.start({ ...TWO_MODELS, ...bashScript("echo parked") });
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(await host.request({ type: "set_model", provider: "faux", modelId: "thinker" })).toMatchObject({
      success: false,
      error: WORKER_BUSY,
    });
    expect(await host.request({ type: "set_thinking_level", level: "low" })).toMatchObject({ success: true });
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    await host.waitFor((r) => r.type === "agent_settled");
  });

  it("applies a level set during a run to the next model request (M7R43)", async () => {
    const capture = join(bed.root, "thinking.jsonl");
    await bed.start({
      ...bashScript("echo parked"),
      modelId: "thinker",
      reasoning: true,
      captureThinking: capture,
    });
    const host = bed.host();
    const ready = await host.waitFor((r) => r.type === "loadout");
    const startLevel = (ready.loadout as { thinkingLevel: string }).thinkingLevel;
    host.send({ type: "prompt", id: "p1", message: "go" });
    // The first request has been answered (the tool call is waiting for the owner); the second has not started.
    const ask = await host.waitFor(isApproval);
    expect(await host.request({ type: "set_thinking_level", level: "high" })).toMatchObject({
      success: true,
    });
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
    await host.waitFor((r) => r.type === "agent_settled");
    const lines = readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { model: string; thinking: string });
    expect(lines).toEqual([
      { model: "thinker", thinking: startLevel },
      { model: "thinker", thinking: "high" },
    ]);
    expect(startLevel).not.toBe("high");
  });
});
