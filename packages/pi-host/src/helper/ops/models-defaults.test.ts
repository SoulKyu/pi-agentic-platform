import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed, modelsJsonWith } from "../../testing/models-bed.ts";
import { setDefault, setDefaultThinking } from "./models-defaults.ts";

let bed: ModelsBed;
let settings: string;
beforeEach(async () => {
  bed = await makeModelsBed();
  settings = join(bed.agentDir, "settings.json");
  vi.stubEnv("PI_OFFLINE", "1");
  await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(2));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.chmod(bed.agentDir, 0o700).catch(() => undefined);
  await bed.cleanup();
});

const choose = (provider: string, modelId: string, cwd?: string) =>
  setDefault.run({ provider, modelId }, bed.context(cwd ? { cwd } : {}));
const failureOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("models.setDefault", () => {
  it("writes defaultProvider and defaultModel and nothing else", async () => {
    await bed.write(settings, { theme: "dark", enabledModels: ["mine/*"] });
    expect(await choose("mine", "m2")).toEqual({ ok: true });
    expect(await bed.read(settings)).toEqual({
      theme: "dark",
      enabledModels: ["mine/*"],
      defaultProvider: "mine",
      defaultModel: "m2",
    });
  });

  it("creates settings.json when there is none", async () => {
    await choose("mine", "m1");
    expect(await bed.read(settings)).toEqual({ defaultProvider: "mine", defaultModel: "m1" });
  });

  it("refuses a model outside the enabled scope with bad_request and leaves the file alone", async () => {
    await bed.write(settings, { enabledModels: ["anthropic/*"] });
    const before = await fs.readFile(settings, "utf8");
    expect(await failureOf(choose("mine", "m1"))).toMatchObject({ code: "bad_params" });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
  });

  it("accepts a model the scope names even when its provider has no key yet", async () => {
    await bed.write(settings, { enabledModels: ["mine/m1"] });
    await choose("mine", "m1");
    expect((await bed.read(settings)) as object).toMatchObject({ defaultModel: "m1" });
  });

  it("answers not_found for a model that does not exist", async () => {
    expect(await failureOf(choose("mine", "nope"))).toMatchObject({ code: "not_found" });
    expect(await failureOf(choose("nobody", "m1"))).toMatchObject({ code: "not_found" });
    await expect(fs.stat(settings)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers project_scope when a trusted project sets the key, naming its file, and leaves the global file alone", async () => {
    await bed.write(settings, { theme: "dark" });
    const before = await fs.readFile(settings, "utf8");
    const file = join(bed.project, ".pi", "settings.json");
    await bed.write(file, { defaultModel: "m1" });
    await bed.trust(bed.project);
    const failure = await failureOf(choose("mine", "m2", bed.project));
    expect(failure).toMatchObject({ code: "project_scope", message: file });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
  });

  it("writes the global file when the project is not trusted, or does not set the key", async () => {
    const file = join(bed.project, ".pi", "settings.json");
    await bed.write(file, { defaultModel: "m1" });
    await choose("mine", "m2", bed.project);
    expect((await bed.read(settings)) as object).toMatchObject({ defaultModel: "m2" });
    await bed.trust(bed.project);
    await bed.write(file, { theme: "dark" });
    await choose("mine", "m1", bed.project);
    expect((await bed.read(settings)) as object).toMatchObject({ defaultModel: "m1" });
  });

  it("checks the scope the trusted project sets, not only the global one", async () => {
    await bed.write(join(bed.project, ".pi", "settings.json"), { enabledModels: ["anthropic/*"] });
    await bed.trust(bed.project);
    expect(await failureOf(choose("mine", "m1", bed.project))).toMatchObject({ code: "bad_params" });
  });

  it("fails with config_invalid on a settings.json that is not valid, and does not overwrite it", async () => {
    await fs.writeFile(settings, "{ nope");
    expect(await failureOf(choose("mine", "m1"))).toMatchObject({ code: "config_invalid" });
    expect(await fs.readFile(settings, "utf8")).toBe("{ nope");
  });

  it("refuses a settings.json that leaves the home folder by a link", async () => {
    const outside = join(bed.root, "outside.json");
    await fs.writeFile(outside, "{}");
    await fs.symlink(outside, settings);
    expect(await failureOf(choose("mine", "m1"))).toMatchObject({ code: "config_path_refused" });
    expect(await fs.readFile(outside, "utf8")).toBe("{}");
  });

  it("refuses a settings.json with another hard link at write time", async () => {
    await bed.write(settings, { theme: "dark" });
    await fs.link(settings, join(bed.root, "twin.json"));
    const before = await fs.readFile(settings, "utf8");
    expect(await failureOf(choose("mine", "m1"))).toMatchObject({
      code: "config_path_refused",
      message: "hard-link",
    });
    expect(await fs.readFile(settings, "utf8")).toBe(before);
  });

  it("reports a write Pi could not make instead of resolving", async () => {
    await bed.write(settings, { theme: "dark" });
    await fs.chmod(settings, 0o400);
    expect(await failureOf(choose("mine", "m1"))).toMatchObject({ code: "failed" });
  });

  it("checks its params", () => {
    expect(setDefault.params.safeParse({ provider: "p", modelId: "m" }).success).toBe(true);
    expect(setDefault.params.safeParse({ provider: "p" }).success).toBe(false);
    expect(setDefault.params.safeParse({ provider: "p", modelId: "m", cwd: "/x" }).success).toBe(false);
  });
});

describe("models.setDefaultThinking", () => {
  const level = (value: string, cwd?: string) =>
    setDefaultThinking.run({ level: value as "high" }, bed.context(cwd ? { cwd } : {}));

  it("writes defaultThinkingLevel and nothing else", async () => {
    await bed.write(settings, { theme: "dark" });
    expect(await level("high")).toEqual({ ok: true });
    expect(await bed.read(settings)).toEqual({ theme: "dark", defaultThinkingLevel: "high" });
  });

  it("answers project_scope when a trusted project sets the level", async () => {
    const file = join(bed.project, ".pi", "settings.json");
    await bed.write(file, { defaultThinkingLevel: "low" });
    await level("high", bed.project);
    expect((await bed.read(settings)) as object).toEqual({ defaultThinkingLevel: "high" });
    await bed.trust(bed.project);
    expect(await failureOf(level("medium", bed.project))).toMatchObject({
      code: "project_scope",
      message: file,
    });
    expect((await bed.read(settings)) as object).toEqual({ defaultThinkingLevel: "high" });
  });

  it("refuses a level Pi does not know", () => {
    expect(setDefaultThinking.params.safeParse({ level: "huge" }).success).toBe(false);
  });
});
