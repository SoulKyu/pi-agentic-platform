import { join } from "node:path";
import {
  type AgentSession,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshAvailable, listAvailable } from "./available-models.ts";
import { handleGetAvailableModels, handleSetModel } from "./model-commands.ts";
import { makeModelsBed, type ModelsBed } from "./testing/models-bed.ts";
import { blockedAttempts } from "./testing/network-guard.ts";

let bed: ModelsBed;
beforeEach(async () => {
  bed = await makeModelsBed();
  vi.stubEnv("PI_OFFLINE", "1");
  await bed.write(join(bed.agentDir, "auth.json"), { anthropic: { type: "api_key", key: "sk-ant-plain" } });
  await bed.write(join(bed.agentDir, "models.json"), providers("mine"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
});

const providers = (...ids: string[]) => ({
  providers: Object.fromEntries(
    ids.map((id) => [
      id,
      {
        name: id,
        baseUrl: "http://localhost:1/v1",
        apiKey: "plain-key",
        api: "openai-completions",
        models: [{ id: `${id}-1` }, { id: `${id}-2` }],
      },
    ]),
  ),
});

const openRuntime = () =>
  ModelRuntime.create({
    authPath: join(bed.agentDir, "auth.json"),
    modelsPath: join(bed.agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
const keys = (models: ReadonlyArray<{ provider: string; id: string }>) =>
  models.map((model) => `${model.provider}/${model.id}`);
const scopeOf = async (runtime: ModelRuntime, patterns: string[]) =>
  keys(
    (await resolveModelScopeWithDiagnostics(patterns, runtime)).scopedModels.map((scoped) => scoped.model),
  );

describe("listAvailable", () => {
  it("no-patterns-is-signed-in", async () => {
    const runtime = await openRuntime();
    const expected = keys(await runtime.getAvailable());
    for (const patterns of [undefined, []]) {
      const result = await listAvailable(runtime, patterns);
      expect(keys(result.models)).toEqual(expected);
      expect(result.origin).toBe("signed-in");
    }
    expect(expected.some((key) => key.startsWith("openai/"))).toBe(false);
    expect(expected).toContain("mine/mine-1");
    expect(expected.some((key) => key.startsWith("anthropic/"))).toBe(true);
  });

  it("provider-glob", async () => {
    const runtime = await openRuntime();
    const result = await listAvailable(runtime, ["anthropic/*"]);
    expect(result.origin).toBe("scope");
    expect(keys(result.models)).toEqual(await scopeOf(runtime, ["anthropic/*"]));
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("thinking-suffix", async () => {
    const runtime = await openRuntime();
    const id = runtime.getModels("anthropic").find((model) => model.reasoning)?.id ?? "";
    expect(id).not.toBe("");
    const result = await listAvailable(runtime, [`anthropic/${id}:high`]);
    expect(keys(result.models)).toEqual([`anthropic/${id}`]);
    expect(result.origin).toBe("scope");
  });

  it("scope-matches-nothing-falls-back", async () => {
    const runtime = await openRuntime();
    const result = await listAvailable(runtime, ["openai/*"]);
    expect(keys(result.models)).toEqual(keys(await runtime.getAvailable()));
    expect(result.origin).toBe("signed-in");
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("session-scope-wins", async () => {
    const runtime = await openRuntime();
    const [first, second] = (await runtime.getAvailable()).slice(0, 2);
    if (!first || !second) throw new Error("fixture has fewer than two models");
    const result = await listAvailable(runtime, ["anthropic/*"], [{ model: second }, { model: first }]);
    expect(keys(result.models)).toEqual(keys([second, first]));
    expect(result.origin).toBe("session");
  });

  it("order-is-pis", async () => {
    const custom = providers("mine");
    await bed.write(join(bed.agentDir, "models.json"), {
      providers: { mine: { ...custom.providers.mine, models: [{ id: "zulu" }, { id: "alpha" }] } },
    });
    const runtime = await openRuntime();
    const result = await listAvailable(runtime, undefined);
    expect(keys(result.models)).toEqual(keys(await runtime.getAvailable()));
    const mine = keys(result.models).filter((key) => key.startsWith("mine/"));
    expect(mine).toEqual(["mine/zulu", "mine/alpha"]);
  });

  it("does-not-list-unsigned-provider-models-even-if-patterns-name-them", async () => {
    const runtime = await openRuntime();
    const result = await listAvailable(runtime, ["anthropic/*", "openai/*"]);
    expect(result.origin).toBe("scope");
    expect(keys(result.models).some((key) => key.startsWith("openai/"))).toBe(false);
    expect(keys(result.models).some((key) => key.startsWith("anthropic/"))).toBe(true);
  });
});

describe("freshAvailable (MPR25)", () => {
  const settingsOf = () => SettingsManager.create(bed.project, bed.agentDir, { projectTrusted: false });

  it("worker.warm-sees-new-provider", async () => {
    const runtime = await openRuntime();
    const settings = settingsOf();
    expect(keys((await listAvailable(runtime, settings.getEnabledModels())).models)).not.toContain(
      "fresh/fresh-1",
    );
    await bed.write(join(bed.agentDir, "models.json"), providers("mine", "fresh"));
    const stale = await listAvailable(runtime, settings.getEnabledModels());
    expect(keys(stale.models)).not.toContain("fresh/fresh-1");
    const fresh = await freshAvailable(runtime, settings, undefined, true);
    expect(keys(fresh.models)).toContain("fresh/fresh-1");
    const afterwards = await listAvailable(await openRuntime(), undefined);
    expect(keys(fresh.models)).toEqual(keys(afterwards.models));
    expect(blockedAttempts).toEqual([]);
  });

  it("worker.warm-sees-new-enabled-models", async () => {
    const runtime = await openRuntime();
    const settings = settingsOf();
    expect((await listAvailable(runtime, settings.getEnabledModels())).origin).toBe("signed-in");
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["mine/*"] });
    const stale = await listAvailable(runtime, settings.getEnabledModels());
    expect(stale.origin).toBe("signed-in");
    const fresh = await freshAvailable(runtime, settings, undefined, true);
    expect(fresh.origin).toBe("scope");
    expect(keys(fresh.models)).toEqual(["mine/mine-1", "mine/mine-2"]);
  });

  it("worker.busy-keeps-snapshot", async () => {
    const runtime = await openRuntime();
    const settings = settingsOf();
    const before = keys((await listAvailable(runtime, settings.getEnabledModels())).models);
    await bed.write(join(bed.agentDir, "models.json"), providers("mine", "fresh"));
    const reload = vi.spyOn(settings, "reload");
    const refresh = vi.spyOn(runtime, "refresh");
    const busy = await freshAvailable(runtime, settings, undefined, false);
    expect(reload).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(keys(busy.models)).toEqual(before);
  });

  it("worker.handlers-use-fresh", async () => {
    const runtime = await openRuntime();
    const settings = settingsOf();
    const setModel = vi.fn(async () => {});
    const session = {
      modelRuntime: runtime,
      settingsManager: settings,
      scopedModels: [],
      isIdle: true,
      model: undefined,
      thinkingLevel: "off",
      getActiveToolNames: () => [],
      getAvailableThinkingLevels: () => ["off"],
      setModel,
    } as unknown as AgentSession;
    await bed.write(join(bed.agentDir, "models.json"), providers("mine", "fresh"));

    const sent: Array<Record<string, unknown>> = [];
    const send = (record: Record<string, unknown>) => void sent.push(record);
    await handleGetAvailableModels(session, { id: "r1" }, send as never);
    const listed = (
      sent.at(-1) as { data: { models: Array<{ provider: string; id: string }> } }
    ).data.models.map((model) => `${model.provider}/${model.id}`);
    expect(listed).toContain("fresh/fresh-1");

    await handleSetModel(session, { id: "r2", provider: "fresh", modelId: "fresh-2" }, send as never);
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls[0]).toMatchObject([{ provider: "fresh", id: "fresh-2" }]);
    expect(sent.at(-1)).toMatchObject({ id: "r2", command: "set_model", success: true });
  });
});
