import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelsOverview } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeModelsBed,
  type ModelsBed,
  modelsJsonWith,
  SECRET_AUTH_KEY,
  SECRET_MODELS_KEY,
} from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { modelsOverview } from "./models-overview.ts";

let bed: ModelsBed;
beforeEach(async () => {
  bed = await makeModelsBed();
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
});

const overview = async (cwd?: string) => modelsOverview.run({}, bed.context(cwd ? { cwd } : {}));
const providerOf = (result: ModelsOverview, id: string) => result.providers.find((p) => p.id === id);

describe("models.overview", () => {
  it("takes no params", () => {
    expect(modelsOverview.params.safeParse({}).success).toBe(true);
    expect(modelsOverview.params.safeParse({ cwd: "/x" }).success).toBe(false);
  });

  it("lists built-in providers and the models.json ones with their origin and models", async () => {
    await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(2));
    const result = await overview();
    expect(ModelsOverview.safeParse(result).success).toBe(true);
    const mine = providerOf(result, "mine");
    expect(mine).toMatchObject({ id: "mine", name: "Mine", origin: "models.json", modelsTruncated: false });
    expect(mine?.models.map((m) => [m.id, m.name, m.enabled])).toEqual([
      ["m1", "Model 1", true],
      ["m2", "Model 2", true],
    ]);
    expect(providerOf(result, "anthropic")).toMatchObject({ origin: "builtin" });
    expect(providerOf(result, "anthropic")?.models.length).toBeGreaterThan(0);
    expect(result.offline).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("lists a provider once, with the kinds of sign-in it offers", async () => {
    const result = await overview();
    expect(new Set(result.providers.map((p) => p.id)).size).toBe(result.providers.length);
    expect(providerOf(result, "anthropic")?.auth).toEqual({
      oauthLabel: "Anthropic (Claude Pro/Max)",
      apiKey: true,
      configured: false,
      stored: null,
      status: "known",
      env: [
        { name: "ANTHROPIC_AUTH_TOKEN", set: false },
        { name: "ANTHROPIC_OAUTH_TOKEN", set: false },
        { name: "ANTHROPIC_API_KEY", set: false },
      ],
    });
  });

  it("says which environment variables of a provider are set (MC26), never their value, and signs nobody in by them", async () => {
    const secret = "sk-from-the-environment";
    vi.stubEnv("OPENAI_API_KEY", secret);
    const result = await overview();
    expect(providerOf(result, "openai")?.auth).toMatchObject({
      configured: false,
      stored: null,
      env: [{ name: "OPENAI_API_KEY", set: true }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("marks enabled from a glob in enabledModels and reports the scope and file", async () => {
    await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(2));
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["mine/*"] });
    const result = await overview();
    expect(result.enabled).toEqual({
      patterns: ["mine/*"],
      scope: "global",
      settingsPath: join(bed.agentDir, "settings.json"),
      warnings: [],
    });
    expect(providerOf(result, "mine")?.models.every((m) => m.enabled)).toBe(true);
    expect(providerOf(result, "anthropic")?.models.some((m) => m.enabled)).toBe(false);
  });

  it("warns about a pattern that matches nothing, without echoing more than the pattern", async () => {
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["nothing/here"] });
    const result = await overview();
    expect(result.enabled.warnings).toEqual(['No model matches "nothing/here".']);
    expect(providerOf(result, "anthropic")?.models.some((m) => m.enabled)).toBe(false);
  });

  it("never carries a key from models.json or auth.json, and reports what is stored", async () => {
    await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(1));
    await bed.write(join(bed.agentDir, "auth.json"), {
      anthropic: { type: "api_key", key: SECRET_AUTH_KEY },
    });
    const result = await overview();
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET_MODELS_KEY);
    expect(text).not.toContain(SECRET_AUTH_KEY);
    expect(providerOf(result, "anthropic")?.auth).toMatchObject({ configured: true, stored: "api_key" });
    expect(providerOf(result, "mine")?.auth).toEqual({
      oauthLabel: null,
      apiKey: true,
      configured: true,
      stored: null,
      status: "known",
      env: [],
    });
  });

  it("never runs the command a models.json key names", async () => {
    const marker = join(bed.root, "ran");
    const config = modelsJsonWith(1, `!touch ${marker}`);
    await bed.write(join(bed.agentDir, "models.json"), config);
    const result = await overview();
    expect(providerOf(result, "mine")?.auth.configured).toBe(true);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(result)).not.toContain("touch");
  });

  it("reads the defaults", async () => {
    await bed.write(join(bed.agentDir, "settings.json"), {
      defaultProvider: "anthropic",
      defaultModel: "claude-x",
      defaultThinkingLevel: "high",
    });
    expect((await overview()).defaults).toEqual({
      provider: "anthropic",
      model: "claude-x",
      thinkingLevel: "high",
    });
    await fs.rm(join(bed.agentDir, "settings.json"));
    expect((await overview()).defaults).toEqual({ provider: null, model: null, thinkingLevel: null });
  });

  it("lets a trusted project's settings win, and ignores an untrusted project's", async () => {
    await bed.write(join(bed.agentDir, "settings.json"), { defaultModel: "global-model" });
    const file = join(bed.project, ".pi", "settings.json");
    await bed.write(file, { defaultModel: "project-model", enabledModels: ["anthropic/*"] });
    const untrusted = await overview(bed.project);
    expect(untrusted.defaults.model).toBe("global-model");
    expect(untrusted.enabled).toMatchObject({ scope: "global", patterns: null });
    await bed.trust(bed.project);
    const trusted = await overview(bed.project);
    expect(trusted.defaults.model).toBe("project-model");
    expect(trusted.enabled).toMatchObject({
      scope: "project",
      settingsPath: file,
      patterns: ["anthropic/*"],
    });
  });

  it("creates Pi's runtime without a catalog refresh and without the network (side-effect-free discovery)", async () => {
    const create = vi.spyOn(ModelRuntime, "create");
    await overview();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ refreshOnCreate: false, allowModelNetwork: false });
    create.mockRestore();
  });

  it("makes no request even when the network is allowed in the environment", async () => {
    vi.unstubAllEnvs();
    delete process.env.PI_OFFLINE;
    await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(1));
    await overview();
    expect(blockedAttempts).toEqual([]);
  });

  it("reports offline from PI_OFFLINE", async () => {
    expect((await overview()).offline).toBe(true);
    vi.unstubAllEnvs();
    vi.stubEnv("PI_OFFLINE", undefined as unknown as string);
    delete process.env.PI_OFFLINE;
    expect((await overview()).offline).toBe(false);
  });

  it("keeps the built-in providers and warns, with a fixed text, when models.json is not valid", async () => {
    await fs.writeFile(join(bed.agentDir, "models.json"), `{ "providers": ${SECRET_MODELS_KEY} nope`);
    const result = await overview();
    expect(providerOf(result, "anthropic")).toBeDefined();
    expect(result.enabled.warnings).toEqual([
      "Pi could not read models.json or a provider in it.",
      "models.json could not be read: its providers' sign-in status is unknown.",
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET_MODELS_KEY);
  });

  it("warns when settings.json is not valid", async () => {
    await fs.writeFile(join(bed.agentDir, "settings.json"), "{ nope");
    expect((await overview()).enabled.warnings).toEqual(["Pi could not read the global settings.json."]);
  });

  it("cuts a provider's models at 2000 and the providers at 300", async () => {
    const manyModels = modelsJsonWith(2500);
    await bed.write(join(bed.agentDir, "models.json"), manyModels);
    const result = await overview();
    const mine = providerOf(result, "mine");
    expect(mine?.models).toHaveLength(2000);
    expect(mine?.modelsTruncated).toBe(true);

    const providers = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `p${String(i).padStart(3, "0")}`,
        { baseUrl: "http://localhost:1/v1", apiKey: "k", api: "openai-completions", models: [{ id: "x" }] },
      ]),
    );
    await bed.write(join(bed.agentDir, "models.json"), { providers });
    const cut = await overview();
    expect(cut.providers).toHaveLength(300);
    expect(cut.truncated).toBe(true);
  });

  it("stays under the byte budget when many large lists arrive, and says it left some out", async () => {
    const wide = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `model-${i}`, name: `${"n".repeat(250)}${i}` }));
    const providers = Object.fromEntries(
      ["a", "b", "c"].map((id) => [
        id,
        { baseUrl: "http://localhost:1/v1", apiKey: "k", api: "openai-completions", models: wide(1000) },
      ]),
    );
    await bed.write(join(bed.agentDir, "models.json"), { providers });
    const result = await overview();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(800_000);
    expect(ModelsOverview.safeParse(result).success).toBe(true);
    expect(result.truncated || result.providers.some((p) => p.modelsTruncated)).toBe(true);
  });

  it("refuses a models.json that is a link leaving the home folder, with a reason and no content", async () => {
    const outside = join(bed.root, "outside.json");
    await fs.writeFile(outside, JSON.stringify(modelsJsonWith(1)));
    await fs.symlink(outside, join(bed.agentDir, "models.json"));
    await expect(overview()).rejects.toMatchObject({ code: "config_path_refused", message: "link-outside" });
  });

  it("refuses an auth.json that is not a regular file", async () => {
    await fs.mkdir(join(bed.agentDir, "auth.json"));
    await expect(overview()).rejects.toMatchObject({ code: "config_path_refused" });
  });
});
