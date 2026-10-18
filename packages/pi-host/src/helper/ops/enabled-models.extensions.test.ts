import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed, modelsJsonWith } from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { type EnabledOp, setEnabled } from "./enabled-models.ts";

// The owner's "My selection" names an extension's models with the same op and Pi's own matching (ADR 0070 as amended).
let bed: ModelsBed;
let settings: string;
let marker: string;
beforeEach(async () => {
  bed = await makeModelsBed();
  settings = join(bed.agentDir, "settings.json");
  marker = join(bed.root, "extension-loaded");
  vi.stubEnv("PI_OFFLINE", "1");
  await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(3));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
  expect(blockedAttempts).toEqual([]);
});

/** An extension provider with a key and two models; every load of it leaves a line in the marker file. */
async function extension(source = bridgeLike()): Promise<void> {
  await fs.mkdir(join(bed.agentDir, "extensions"), { recursive: true });
  await fs.writeFile(join(bed.agentDir, "extensions", "ext.ts"), source);
}
/** `onLoad`: code the extension runs first, at each load (a write of another process, in the load's window). */
const bridgeLike = (ids: readonly string[] = ["e0", "e1"], onLoad = "") =>
  `import { appendFileSync, writeFileSync } from "node:fs";\n` +
  `export default function (pi) { ${onLoad} appendFileSync(${JSON.stringify(marker)}, "load\\n"); ` +
  `pi.registerProvider("extx", { baseUrl: "https://x.invalid/v1", apiKey: "not-used", api: "openai-completions", ` +
  `models: ${JSON.stringify(ids)}.map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 10, ` +
  `maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) }); }\n`;
const loads = async () =>
  (await fs.readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
const edit = (op: EnabledOp) => setEnabled.run({ op }, bed.context());
const written = async () => ((await bed.read(settings)) as { enabledModels?: string[] }).enabledModels;
const failureOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("models.setEnabled and an extension's models", () => {
  it("ext.toggle-on: writes the exact provider/modelId into My selection, the other entries untouched", async () => {
    await extension();
    await bed.write(settings, { theme: "dark", enabledModels: ["mine/m1", "anthropic/claude-x-gone"] });
    expect(await edit({ op: "toggle", provider: "extx", modelId: "e1", enabled: true })).toEqual({
      patterns: ["mine/m1", "anthropic/claude-x-gone", "extx/e1"],
    });
    expect(await written()).toEqual(["mine/m1", "anthropic/claude-x-gone", "extx/e1"]);
    expect(((await bed.read(settings)) as { theme: string }).theme).toBe("dark");
  });

  it("ext.provider-on: the provider's switch writes its exact glob, as for any provider", async () => {
    await extension();
    await bed.write(settings, { enabledModels: ["mine/m1"] });
    expect(await edit({ op: "provider", provider: "extx", enabled: true })).toEqual({
      patterns: ["mine/m1", "extx/*"],
    });
  });

  it("ext.toggle-off: switching one of a whole provider off rewrites only its entry", async () => {
    await extension();
    await bed.write(settings, { enabledModels: ["mine/m1", "extx/*"] });
    expect(await edit({ op: "toggle", provider: "extx", modelId: "e0", enabled: false })).toEqual({
      patterns: ["mine/m1", "extx/e1"],
    });
  });

  it("ext.only-when-needed: a switch of a provider Pi has without extensions runs no extension code", async () => {
    await extension();
    await bed.write(settings, { enabledModels: ["mine/m1", "extx/e1"] });
    expect(await edit({ op: "toggle", provider: "mine", modelId: "m2", enabled: true })).toEqual({
      patterns: ["mine/m1", "extx/e1", "mine/m2"],
    });
    expect(await loads()).toBe(0);
    await edit({ op: "toggle", provider: "extx", modelId: "e0", enabled: true });
    expect(await loads()).toBe(1);
  });

  it("ext.extension-only-list: a list only an extension's models match is read with the extensions", async () => {
    // Without them Pi would read the list as matching nothing, so every model on, and the switch would widen it.
    await extension();
    await bed.write(settings, { enabledModels: ["extx/*"] });
    expect(await edit({ op: "toggle", provider: "mine", modelId: "m2", enabled: true })).toEqual({
      patterns: ["extx/*", "mine/m2"],
    });
    expect(await loads()).toBe(1);
  });

  it("ext.fails-closed: an extension that does not load writes nothing, and says so by its own code (M7)", async () => {
    await extension('export default function () { throw new Error("boom"); }\n');
    await bed.write(settings, { enabledModels: ["mine/m1"] });
    const before = await fs.readFile(settings, "utf8");
    expect(await failureOf(edit({ op: "provider", provider: "extx", enabled: true }))).toMatchObject({
      code: "extensions_failed",
    });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
  });

  it("ext.unknown: a provider no extension adds either is not_found, and nothing is written", async () => {
    await extension();
    expect(await failureOf(edit({ op: "provider", provider: "nobody", enabled: true }))).toMatchObject({
      code: "not_found",
    });
    await expect(fs.stat(settings)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("a switch planned without extensions never drops an extension's model (review I1, M11, M12)", () => {
  it("i1.shared-entry-off: an entry an extension's model shares is rewritten with the extensions loaded", async () => {
    await extension(bridgeLike(["m1-ext", "e1"]));
    await bed.write(settings, { enabledModels: ["*/m1-*", "mine/m2"] });
    expect(await edit({ op: "toggle", provider: "mine", modelId: "m1", enabled: false })).toBeTruthy();
    // `*/m1-*` matches no model of models.json (`mine/m1`): only the extension's, which stays.
    expect(await written()).toEqual(["*/m1-*", "mine/m2"]);
    await bed.write(settings, { enabledModels: ["*/m1*", "mine/m2"] });
    await edit({ op: "toggle", provider: "mine", modelId: "m1", enabled: false });
    const after = (await written()) ?? [];
    expect(after).toContain("extx/m1-ext");
    expect(after).toContain("mine/m2");
    expect(after).not.toContain("mine/m1");
    expect(await loads()).toBe(1);
  });

  it("i1.shared-entry-on: switching a model on never folds an entry an extension's model shares into a glob", async () => {
    await extension(bridgeLike(["m1-ext", "e1"]));
    await bed.write(settings, { enabledModels: ["*/m1*", "mine/m2"] });
    expect(await edit({ op: "toggle", provider: "mine", modelId: "m3", enabled: true })).toEqual({
      patterns: ["*/m1*", "mine/m2", "mine/m3"],
    });
    expect(await loads()).toBe(0);
  });

  it("i1.from-all: leaving every-model-on lists the extensions' models too", async () => {
    await extension();
    const result = (await edit({ op: "toggle", provider: "mine", modelId: "m1", enabled: false })) as {
      patterns: string[];
    };
    expect(result.patterns).toContain("extx/*");
    expect(result.patterns).toEqual(expect.arrayContaining(["mine/m2", "mine/m3"]));
    expect(result.patterns).not.toContain("mine/m1");
    expect(await loads()).toBe(1);
  });

  it("m12.not-the-last: switching off the last model Pi has is allowed while an extension's entry still enables one", async () => {
    await extension();
    await bed.write(settings, { enabledModels: ["mine/m1", "extx/*"] });
    expect(await edit({ op: "toggle", provider: "mine", modelId: "m1", enabled: false })).toEqual({
      patterns: ["extx/*"],
    });
    expect(await loads()).toBe(1);
  });

  it("m11.fresh-list: the list is read again after the extensions load, so a write made meanwhile is kept", async () => {
    // Another process (a hand edit, pi-web) writes the list while the extensions load.
    const outside = JSON.stringify({ enabledModels: ["mine/m1", "mine/m2"] });
    await extension(
      bridgeLike(["e0", "e1"], `writeFileSync(${JSON.stringify(settings)}, ${JSON.stringify(outside)});`),
    );
    await bed.write(settings, { enabledModels: ["mine/m1"] });
    expect(await edit({ op: "toggle", provider: "extx", modelId: "e1", enabled: true })).toEqual({
      patterns: ["mine/m1", "mine/m2", "extx/e1"],
    });
  });
});

describe("Clean up and the entries it cannot judge", () => {
  it("prune.keeps-extension-entries: claude-bridge/x survives Clean up; an unmatched entry of a known provider goes", async () => {
    await bed.write(settings, {
      enabledModels: ["mine/m1", "claude-bridge/x", "claude-bridge/*:high", "mine/gone", "opus-typo", "*/z"],
    });
    expect(await edit({ op: "prune" })).toEqual({
      patterns: ["mine/m1", "claude-bridge/x", "claude-bridge/*:high", "opus-typo", "*/z"],
    });
    expect(await written()).toEqual([
      "mine/m1",
      "claude-bridge/x",
      "claude-bridge/*:high",
      "opus-typo",
      "*/z",
    ]);
    expect(await loads()).toBe(0);
  });

  it("prune.only-unjudgeable: a list of entries it cannot judge is left as it is", async () => {
    await bed.write(settings, { enabledModels: ["claude-bridge/x", "renamed-x"] });
    const before = await fs.readFile(settings, "utf8");
    expect(await edit({ op: "prune" })).toEqual({ patterns: ["claude-bridge/x", "renamed-x"] });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
  });
});
