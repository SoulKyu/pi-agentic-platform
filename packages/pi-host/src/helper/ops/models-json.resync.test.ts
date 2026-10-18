import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed, modelsJsonWith } from "../../testing/models-bed.ts";
import { configGet, configSave } from "./models-json.ts";

const KEY = "ab".repeat(32);
let bed: ModelsBed;
let file: string;
let settings: string;
let outside: string;
beforeEach(async () => {
  bed = await makeModelsBed();
  file = join(bed.agentDir, "models.json");
  settings = join(bed.agentDir, "settings.json");
  outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pap-outside-")));
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await bed.cleanup();
  await fs.rm(outside, { recursive: true, force: true });
});
const get = () => configGet.run({ revisionKey: KEY }, bed.context());
const save = (text: string, baseRevision: string) =>
  configSave.run({ text, baseRevision, revisionKey: KEY }, bed.context());

describe("models.config.save: enabledModels follows the file (M7R65)", () => {
  const withModels = (ids: string[]) =>
    JSON.stringify(
      modelsJsonWith(0),
      (key, value: unknown) => (key === "models" ? ids.map((id) => ({ id, name: id })) : value),
      2,
    );

  it("re-asserts a provider that was fully enabled, so a new model is enabled too", async () => {
    await fs.writeFile(file, withModels(["m1", "m2"]));
    await bed.write(settings, { theme: "dark", enabledModels: ["mine/m1", "mine/m2"] });
    const { text, revision } = await get();
    const result = await save((text ?? "").replace(`"id": "m2"`, `"id": "m2"},{"id": "m3"`), revision);
    expect(result).toMatchObject({ enabledModelsSynced: true });
    expect(await bed.read(settings)).toEqual({ theme: "dark", enabledModels: ["mine/*"] });
  });

  it("never folds an entry an extension's model may share into the provider's glob (review I1)", async () => {
    await fs.writeFile(file, withModels(["m1", "m2"]));
    // `*/m1*` covers mine/m1 here and may cover an extension's model too: it stays as written.
    await bed.write(settings, { enabledModels: ["*/m1*", "mine/m2"] });
    const { text, revision } = await get();
    const result = await save((text ?? "").replace(`"id": "m2"`, `"id": "m2"},{"id": "m3"`), revision);
    expect(result).toMatchObject({ enabledModelsSynced: true });
    expect(await bed.read(settings)).toEqual({ enabledModels: ["*/m1*", "mine/m2", "mine/m3"] });
  });

  it("leaves a provider that was only partly enabled alone", async () => {
    await fs.writeFile(file, withModels(["m1", "m2"]));
    await bed.write(settings, { enabledModels: ["mine/m1"] });
    const { text, revision } = await get();
    await save((text ?? "").replace(`"id": "m2"`, `"id": "m2"},{"id": "m3"`), revision);
    expect(await bed.read(settings)).toEqual({ enabledModels: ["mine/m1"] });
  });

  it("does not touch settings.json when there is no enabledModels", async () => {
    await fs.writeFile(file, withModels(["m1"]));
    const { text, revision } = await get();
    await save(text ?? "", revision);
    await expect(fs.stat(settings)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still answers ok, with enabledModelsSynced false, when settings.json cannot be updated", async () => {
    await fs.writeFile(file, withModels(["m1", "m2"]));
    await bed.write(settings, { enabledModels: ["mine/m1", "mine/m2"] });
    const target = join(outside, "settings.json");
    await fs.rename(settings, target);
    await fs.symlink(target, settings);
    const { text, revision } = await get();
    const edited = (text ?? "").replace(`"id": "m2"`, `"id": "m2"},{"id": "m3"`);
    expect(await save(edited, revision)).toMatchObject({ enabledModelsSynced: false });
    expect(await fs.readFile(file, "utf8")).toContain(`"m3"`);
  });
});
