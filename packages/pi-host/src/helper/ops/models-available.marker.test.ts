import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAvailable } from "../../available-models.ts";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { modelsAvailable } from "./models-available.ts";

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

const exists = (path: string) =>
  fs.access(path).then(
    () => true,
    () => false,
  );

async function plantCommands() {
  const markerAuth = join(bed.root, "marker-auth");
  const markerModels = join(bed.root, "marker-models");
  const markerHeader = join(bed.root, "marker-header");
  await bed.write(join(bed.agentDir, "auth.json"), {
    anthropic: { type: "api_key", key: `!touch ${markerAuth}` },
  });
  await bed.write(join(bed.agentDir, "models.json"), {
    providers: {
      mine: {
        name: "Mine",
        baseUrl: "http://localhost:1/v1",
        apiKey: `!touch ${markerModels}`,
        headers: { "X-Probe": `!touch ${markerHeader}` },
        api: "openai-completions",
        models: [{ id: "m1", name: "Model 1" }],
      },
    },
  });
  return { markerAuth, markerModels, markerHeader };
}

describe("models.available runs no command (MC25, Review Focus 1)", () => {
  it("available.marker.no-command: a hand-written !command key in auth.json or models.json never runs", async () => {
    const { markerAuth, markerModels, markerHeader } = await plantCommands();
    const result = await modelsAvailable.run({}, bed.context());
    expect(await exists(markerAuth)).toBe(false);
    expect(await exists(markerModels)).toBe(false);
    expect(await exists(markerHeader)).toBe(false);
    expect(result.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["anthropic", "mine"]),
    );
    expect(result.models.some((model) => model.provider === "mine")).toBe(true);
    expect(result.models.some((model) => model.provider === "anthropic")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("touch");
  });

  it("available.marker.no-command-online: the same without PI_OFFLINE, as the production helper runs, and the network guard stays empty", async () => {
    vi.unstubAllEnvs();
    const { markerAuth, markerModels, markerHeader } = await plantCommands();
    const result = await modelsAvailable.run({}, bed.context());
    expect(await exists(markerAuth)).toBe(false);
    expect(await exists(markerModels)).toBe(false);
    expect(await exists(markerHeader)).toBe(false);
    expect(result.models.some((model) => model.provider === "mine")).toBe(true);
    expect(blockedAttempts).toEqual([]);
  });

  it("the worker's default store is the stated difference: it resolves the command (MPR1)", async () => {
    const { markerAuth, markerModels, markerHeader } = await plantCommands();
    const worker = await ModelRuntime.create({
      authPath: join(bed.agentDir, "auth.json"),
      modelsPath: join(bed.agentDir, "models.json"),
    });
    const listed = await listAvailable(worker, undefined);
    expect(listed.models.length).toBeGreaterThan(0);
    expect(await exists(markerAuth)).toBe(true);
    expect(await exists(markerModels)).toBe(false);
    expect(await exists(markerHeader)).toBe(false);
  });
});
