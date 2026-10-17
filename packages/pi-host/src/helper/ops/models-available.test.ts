import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AVAILABLE_MODELS_MAX, AVAILABLE_PROVIDERS_MAX, AvailableModels } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAvailable } from "../../available-models.ts";
import { summaryOf } from "../../loadout.ts";
import {
  makeModelsBed,
  type ModelsBed,
  modelsJsonWith,
  SECRET_AUTH_KEY,
  SECRET_MODELS_KEY,
} from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { HelperOpError } from "../ops.ts";
import { MAX_AVAILABLE_BYTES, modelsAvailable } from "./models-available.ts";
import { openSettings, openStoreRuntime } from "./models-open.ts";

let bed: ModelsBed;
beforeEach(async () => {
  bed = await makeModelsBed();
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
  expect(blockedAttempts).toEqual([]);
});

const authPath = () => join(bed.agentDir, "auth.json");
const modelsPath = () => join(bed.agentDir, "models.json");
const settingsPath = () => join(bed.agentDir, "settings.json");
const apiKey = (key: string) => ({ type: "api_key", key });
const available = async (cwd?: string) => modelsAvailable.run({}, bed.context(cwd ? { cwd } : {}));
const ids = (models: ReadonlyArray<{ provider: string; id: string }>) =>
  models.map((model) => `${model.provider}/${model.id}`);

describe("models.available (helper op)", () => {
  it("takes no params", () => {
    expect(modelsAvailable.params.safeParse({}).success).toBe(true);
    expect(modelsAvailable.params.safeParse({ cwd: "/x" }).success).toBe(false);
  });

  it("available.signed-in-only: lists the models of the providers with a key, as listAvailable does", async () => {
    await bed.write(authPath(), { anthropic: apiKey(SECRET_AUTH_KEY) });
    await bed.write(modelsPath(), modelsJsonWith(2));
    const result = await available();
    expect(AvailableModels.safeParse(result).success).toBe(true);
    expect(result.origin).toBe("signed-in");
    expect(result.truncated).toBe(false);
    const providers = new Set(result.models.map((model) => model.provider));
    expect(providers).toEqual(new Set(["anthropic", "mine"]));
    expect(result.models.filter((model) => model.provider === "mine").map((model) => model.id)).toEqual([
      "m1",
      "m2",
    ]);
    const runtime = await openStoreRuntime(bed.context());
    const direct = await listAvailable(runtime, undefined);
    expect(ids(result.models)).toEqual(ids(direct.models));
  });

  it("available.scoped: global enabledModels narrows the list and the origin says so", async () => {
    await bed.write(authPath(), { anthropic: apiKey(SECRET_AUTH_KEY) });
    await bed.write(modelsPath(), modelsJsonWith(2));
    await bed.write(settingsPath(), { enabledModels: ["mine/*"] });
    const result = await available();
    expect(result.origin).toBe("scope");
    expect(ids(result.models)).toEqual(["mine/m1", "mine/m2"]);
  });

  it("available.scope-matches-nothing-falls-back: patterns for an unsigned provider give the signed-in list", async () => {
    await bed.write(modelsPath(), modelsJsonWith(2));
    await bed.write(settingsPath(), { enabledModels: ["openai/*"] });
    const result = await available();
    expect(result.origin).toBe("signed-in");
    expect(ids(result.models)).toEqual(["mine/m1", "mine/m2"]);
  });

  it("available.project-untrusted: project patterns count only when the trust store says trusted", async () => {
    await bed.write(modelsPath(), modelsJsonWith(2));
    await bed.write(join(bed.project, ".pi", "settings.json"), { enabledModels: ["mine/m1"] });
    const untrusted = await available(bed.project);
    expect(untrusted.origin).toBe("signed-in");
    expect(ids(untrusted.models)).toEqual(["mine/m1", "mine/m2"]);
    await bed.trust(bed.project);
    const trusted = await available(bed.project);
    expect(trusted.origin).toBe("scope");
    expect(ids(trusted.models)).toEqual(["mine/m1"]);
  });

  it("available.provider-names: one {id, name} per provider with models, in first-appearance order", async () => {
    await bed.write(authPath(), { anthropic: apiKey(SECRET_AUTH_KEY) });
    await bed.write(modelsPath(), modelsJsonWith(2));
    const result = await available();
    const order = [...new Set(result.models.map((model) => model.provider))];
    expect(result.providers.map((provider) => provider.id)).toEqual(order);
    expect(result.providers).toContainEqual({ id: "mine", name: "Mine" });
    expect(result.providers).toContainEqual({ id: "anthropic", name: "Anthropic" });
  });

  it("available.truncates: 2100 models answer 2000 with truncated true", async () => {
    await bed.write(modelsPath(), modelsJsonWith(AVAILABLE_MODELS_MAX + 100));
    const result = await available();
    expect(result.models).toHaveLength(AVAILABLE_MODELS_MAX);
    expect(result.truncated).toBe(true);
    expect(AvailableModels.safeParse(result).success).toBe(true);
  });

  it("available.truncates: 301 signed-in providers answer 300 and truncated true (I1)", async () => {
    const providers = Object.fromEntries(
      Array.from({ length: AVAILABLE_PROVIDERS_MAX + 1 }, (_, i) => [
        `p${String(i).padStart(3, "0")}`,
        {
          name: `P ${i}`,
          baseUrl: "http://localhost:1/v1",
          apiKey: "local-no-key",
          api: "openai-completions",
          models: [{ id: "m", name: "M" }],
        },
      ]),
    );
    await bed.write(modelsPath(), { providers });
    const result = await available();
    expect(result.providers).toHaveLength(AVAILABLE_PROVIDERS_MAX);
    expect(result.models).toHaveLength(AVAILABLE_PROVIDERS_MAX);
    expect(result.truncated).toBe(true);
    expect(AvailableModels.safeParse(result).success).toBe(true);
  });

  it("available.truncates: the byte budget cuts before the count", async () => {
    const long = "x".repeat(250);
    const config = modelsJsonWith(0);
    config.providers.mine.models = Array.from({ length: 1500 }, (_, i) => ({
      id: `${long}${String(i).padStart(5, "0")}`,
      name: `${long}${i}`,
    })) as never;
    await bed.write(modelsPath(), config);
    const result = await available();
    expect(result.truncated).toBe(true);
    // The list stops at the first row that would not fit: the answer is under the budget, and one more row of the
    // size of the last would have crossed it (no magic margin: the row size is measured).
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const lastRow = Buffer.byteLength(JSON.stringify(result.models.at(-1))) + 1;
    expect(bytes).toBeLessThanOrEqual(MAX_AVAILABLE_BYTES);
    expect(bytes + lastRow).toBeGreaterThan(MAX_AVAILABLE_BYTES);
    expect(result.models.length).toBeLessThan(1500);
  });

  it("available.oauth-expired.no-network: an expired OAuth credential neither refreshes nor blocks the answer", async () => {
    // Without PI_OFFLINE the network guard alone must prove the op asks nothing.
    vi.unstubAllEnvs();
    await bed.write(authPath(), {
      anthropic: { type: "oauth", access: "a-secret-access", refresh: "a-secret-refresh", expires: 1 },
    });
    const result = await available();
    expect(blockedAttempts).toEqual([]);
    expect(result.providers.map((provider) => provider.id)).toContain("anthropic");
    expect(JSON.stringify(result)).not.toContain("a-secret-");
  });

  it("available.token-readable-result-has-no-secret: no stored key, no models.json key, no path", async () => {
    await bed.write(authPath(), { anthropic: apiKey(SECRET_AUTH_KEY) });
    await bed.write(modelsPath(), modelsJsonWith(2));
    const text = JSON.stringify(await available());
    expect(text).not.toContain(SECRET_AUTH_KEY);
    expect(text).not.toContain(SECRET_MODELS_KEY);
    expect(text).not.toContain(bed.root);
    expect(text).not.toContain("localhost");
  });

  it("available.parity-with-worker: the ordered ids equal the list a worker's own runtime gives (plain keys)", async () => {
    await bed.write(authPath(), { anthropic: apiKey(SECRET_AUTH_KEY) });
    await bed.write(modelsPath(), modelsJsonWith(3));
    await bed.write(settingsPath(), { enabledModels: ["mine/m2", "anthropic/*"] });
    const worker = await ModelRuntime.create({ authPath: authPath(), modelsPath: modelsPath() });
    await worker.refresh({ allowNetwork: false });
    const settings = await openSettings(bed.context());
    const expected = await listAvailable(worker, settings.manager.getEnabledModels());
    const result = await available();
    expect(result.origin).toBe(expected.origin);
    expect(ids(result.models)).toEqual(ids(expected.models.filter((m) => summaryOf(m) !== null)));
    expect(result.models.length).toBeGreaterThan(1);
  });

  it("available.parity-with-worker: a catalog cached by Refresh catalog is listed as the worker lists it (I2)", async () => {
    await bed.write(authPath(), { openrouter: apiKey(SECRET_AUTH_KEY) });
    await bed.write(join(bed.agentDir, "models-store.json"), {
      openrouter: {
        checkedAt: 1,
        lastModified: 32_503_680_000_000,
        models: [
          {
            id: "cached/only-model",
            name: "Cached Only",
            api: "openai-completions",
            provider: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
            type: "chat",
          },
        ],
      },
    });
    const worker = await ModelRuntime.create({ authPath: authPath(), modelsPath: modelsPath() });
    await worker.refresh({ allowNetwork: false });
    const expected = await listAvailable(worker, undefined);
    expect(ids(expected.models)).toContain("openrouter/cached/only-model");
    const result = await available();
    expect(ids(result.models)).toEqual(ids(expected.models));
  });

  it("available.refused-link: an auth.json that is a link reaches the daemon as config_path_refused", async () => {
    await bed.write(join(bed.root, "elsewhere.json"), {});
    await fs.symlink(join(bed.root, "elsewhere.json"), authPath());
    const error = await available().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HelperOpError);
    expect((error as HelperOpError).code).toBe("config_path_refused");
  });

  it("available.corrupt-auth-json: fails for the helper and for the worker's store, and says nothing of the file", async () => {
    await fs.writeFile(authPath(), "NOT-JSON-CONTENT {{{");
    const error = await available().then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(HelperOpError);
    expect((error as HelperOpError).code).toBe("config_invalid");
    expect(String(error?.message)).not.toContain("NOT-JSON-CONTENT");
    await expect(
      ModelRuntime.create({ authPath: authPath(), modelsPath: modelsPath() }).then((runtime) =>
        runtime.getAvailable(),
      ),
    ).rejects.toThrow();
  });
});
