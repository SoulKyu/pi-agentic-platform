import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed, modelsJsonWith } from "../../testing/models-bed.ts";
import type { EnabledOp } from "./enabled-models.ts";
import { setEnabled } from "./enabled-models.ts";
import { enabledByPatterns, openRuntime } from "./models-open.ts";

let bed: ModelsBed;
let settings: string;
beforeEach(async () => {
  bed = await makeModelsBed();
  settings = join(bed.agentDir, "settings.json");
  vi.stubEnv("PI_OFFLINE", "1");
  await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(3));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.chmod(bed.agentDir, 0o700).catch(() => undefined);
  await bed.cleanup();
});

const edit = (op: EnabledOp, cwd?: string) => setEnabled.run({ op }, bed.context(cwd ? { cwd } : {}));
const toggle = (modelId: string, enabled: boolean, provider = "mine"): EnabledOp => ({
  op: "toggle",
  provider,
  modelId,
  enabled,
});
const failureOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
/** Pi's own answer, over the real runtime of the bed (built-in catalog plus models.json), to what a list enables. */
async function enabledBy(patterns: readonly string[] | undefined) {
  const runtime = await openRuntime(bed.context());
  const all = runtime.getModels().map((model) => `${model.provider}/${model.id}`);
  if (!patterns || patterns.length === 0) return { all, enabled: new Set(all) };
  return { all, enabled: new Set((await enabledByPatterns(runtime, patterns)).keys) };
}

describe("models.setEnabled", () => {
  it("switches one model off from every-model and Pi enables exactly the others", async () => {
    await bed.write(settings, { theme: "dark", defaultThinkingLevel: "high", packages: ["npm:x"] });
    const result = (await edit(toggle("m2", false))) as { patterns: string[] | null };
    expect(result.patterns).not.toBeNull();
    const written = (await bed.read(settings)) as Record<string, unknown>;
    expect(written.enabledModels).toEqual(result.patterns);
    const { all, enabled } = await enabledBy(result.patterns as string[]);
    expect(all).toContain("mine/m2");
    expect([...enabled].sort()).toEqual(all.filter((key) => key !== "mine/m2").sort());
  });

  it("writes only enabledModels: every other key of settings.json survives a JSON round trip", async () => {
    const others = { theme: "dark", defaultProvider: "mine", nested: { a: [1, 2, { b: null }] }, "x-y": "é" };
    await bed.write(settings, { ...others, enabledModels: ["mine/*"] });
    await edit(toggle("m1", false));
    const { enabledModels, ...rest } = (await bed.read(settings)) as Record<string, unknown>;
    expect(enabledModels).toEqual(["mine/m2", "mine/m3"]);
    expect(JSON.stringify(rest)).toBe(JSON.stringify(others));
  });

  it("creates settings.json when there is none", async () => {
    await edit(toggle("m1", false));
    const written = (await bed.read(settings)) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["enabledModels"]);
    expect(written.enabledModels).toContain("mine/m2");
    expect(written.enabledModels).not.toContain("mine/m1");
  });

  it("collapses a provider that is whole again to its glob", async () => {
    await bed.write(settings, { enabledModels: ["mine/m1", "mine/m2"] });
    expect(await edit(toggle("m3", true))).toEqual({ patterns: ["mine/*"] });
    expect(((await bed.read(settings)) as { enabledModels: string[] }).enabledModels).toEqual(["mine/*"]);
  });

  it("does not touch the file when nothing changes", async () => {
    const raw = '{ "theme":"dark",\n   "enabledModels": ["mine/*"] }\n';
    await fs.writeFile(settings, raw);
    expect(await edit(toggle("m1", true))).toEqual({ patterns: ["mine/*"] });
    expect(await fs.readFile(settings, "utf8")).toBe(raw);
  });

  it("refuses to switch off the last enabled model with conflict and leaves the file alone", async () => {
    await bed.write(settings, { enabledModels: ["mine/m1"] });
    const before = await fs.readFile(settings, "utf8");
    expect(await failureOf(edit(toggle("m1", false)))).toMatchObject({ code: "conflict" });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
  });

  it("clear removes the key and keeps the rest", async () => {
    await bed.write(settings, { theme: "dark", enabledModels: ["mine/m1"] });
    expect(await edit({ op: "clear" })).toEqual({ patterns: null });
    expect(await bed.read(settings)).toEqual({ theme: "dark" });
  });

  it("prune drops the entries that match nothing", async () => {
    await bed.write(settings, { enabledModels: ["gone/*", "mine/m1", "renamed-x"] });
    expect(await edit({ op: "prune" })).toEqual({ patterns: ["mine/m1"] });
    expect(((await bed.read(settings)) as { enabledModels: string[] }).enabledModels).toEqual(["mine/m1"]);
  });

  it("provider off keeps the other providers enabled", async () => {
    await bed.write(settings, { enabledModels: ["mine/*", "anthropic/*"] });
    expect(await edit({ op: "provider", provider: "mine", enabled: false })).toEqual({
      patterns: ["anthropic/*"],
    });
  });

  it("resync re-asserts the providers it is given", async () => {
    await bed.write(settings, { enabledModels: ["anthropic/*", "mine/m1"] });
    expect(await edit({ op: "resync", providers: ["mine"] })).toEqual({
      patterns: ["anthropic/*", "mine/*"],
    });
  });

  it("answers not_found for a model or a provider that does not exist, writing nothing", async () => {
    expect(await failureOf(edit(toggle("nope", false)))).toMatchObject({ code: "not_found" });
    expect(await failureOf(edit(toggle("m1", false, "nobody")))).toMatchObject({ code: "not_found" });
    expect(await failureOf(edit({ op: "provider", provider: "nobody", enabled: true }))).toMatchObject({
      code: "not_found",
    });
    await expect(fs.stat(settings)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers project_scope when a trusted project sets enabledModels, naming its file", async () => {
    await bed.write(settings, { enabledModels: ["mine/*"] });
    const before = await fs.readFile(settings, "utf8");
    const file = join(bed.project, ".pi", "settings.json");
    await bed.write(file, { enabledModels: ["mine/m1"] });
    expect(await edit(toggle("m2", true), bed.project)).toEqual({ patterns: ["mine/*"] });
    await bed.trust(bed.project);
    expect(await failureOf(edit(toggle("m2", true), bed.project))).toMatchObject({
      code: "project_scope",
      message: file,
    });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
  });

  it("fails with config_invalid on a settings.json that is not valid, and does not overwrite it", async () => {
    await fs.writeFile(settings, "{ nope");
    expect(await failureOf(edit(toggle("m1", false)))).toMatchObject({ code: "config_invalid" });
    expect(await fs.readFile(settings, "utf8")).toBe("{ nope");
  });

  it("refuses a settings.json that leaves the home folder by a link", async () => {
    const outside = join(bed.root, "outside.json");
    await fs.writeFile(outside, "{}");
    await fs.symlink(outside, settings);
    expect(await failureOf(edit(toggle("m1", false)))).toMatchObject({ code: "config_path_refused" });
    expect(await fs.readFile(outside, "utf8")).toBe("{}");
  });

  it("refuses a settings.json with another hard link, checked at write time, and leaves both names alone", async () => {
    await bed.write(settings, { enabledModels: ["mine/*"] });
    const twin = join(bed.root, "twin.json");
    await fs.link(settings, twin);
    const before = await fs.readFile(settings, "utf8");
    expect(await failureOf(edit(toggle("m1", false)))).toMatchObject({
      code: "config_path_refused",
      message: "hard-link",
    });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
    expect(await fs.readFile(twin, "utf8")).toBe(before);
  });

  it("reports a write Pi could not make instead of resolving", async () => {
    await bed.write(settings, { theme: "dark" });
    await fs.chmod(settings, 0o400);
    expect(await failureOf(edit(toggle("m1", false)))).toMatchObject({ code: "failed" });
  });

  it("fails with config_invalid on an enabledModels that is not a list of strings", async () => {
    for (const value of ["mine/*", [1], { a: 1 }]) {
      await bed.write(settings, { enabledModels: value });
      expect(await failureOf(edit(toggle("m1", false)))).toMatchObject({ code: "config_invalid" });
    }
  });

  it("checks its params", () => {
    const ok = (value: unknown) => setEnabled.params.safeParse(value).success;
    expect(ok({ op: { op: "clear" } })).toBe(true);
    expect(ok({ op: { op: "toggle", provider: "p", modelId: "m", enabled: false } })).toBe(true);
    expect(ok({ op: { op: "toggle", provider: "p", modelId: "m" } })).toBe(false);
    expect(ok({ op: { op: "clear", extra: 1 } })).toBe(false);
    expect(ok({ op: { op: "nope" } })).toBe(false);
    expect(ok({ op: { op: "clear" }, cwd: "/x" })).toBe(false);
  });
});
