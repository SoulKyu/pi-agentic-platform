import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { configGet, configSave } from "./models-json.ts";

// A `!command` value is code execution (MC24): neither the validation load nor the resync may run one.
const KEY = "ab".repeat(32);
let bed: ModelsBed;
const marker = (name: string) => join(bed.root, `ran-${name}`);
const exists = (path: string) =>
  fs.stat(path).then(
    () => true,
    () => false,
  );
const FIELDS = ["key", "header", "new-key", "new-header"] as const;

const provider = (prefix: string, models: string[]) => ({
  providers: {
    mine: {
      baseUrl: "http://localhost:1/v1",
      apiKey: `!touch ${marker(`${prefix}key`)}`,
      headers: { "X-A": `!touch ${marker(`${prefix}header`)}` },
      api: "openai-completions",
      models: models.map((id) => ({ id })),
    },
  },
});

beforeEach(async () => {
  bed = await makeModelsBed();
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
});

describe("saving models.json never runs a command value", () => {
  it("not while reading, validating, writing or re-asserting enabledModels", async () => {
    await bed.write(join(bed.agentDir, "models.json"), provider("", ["m1", "m2"]));
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["mine/m1", "mine/m2"] });
    const ctx = bed.context();
    const { text, revision } = await configGet.run({ revisionKey: KEY }, ctx);
    const edited = (text ?? "").replace(`"id": "m2"`, `"id": "m2" }, { "id": "m3"`);
    const result = await configSave.run({ text: edited, baseRevision: revision, revisionKey: KEY }, ctx);
    expect(result).toMatchObject({ enabledModelsSynced: true });
    expect(await bed.read(join(bed.agentDir, "settings.json"))).toEqual({ enabledModels: ["mine/*"] });
    // a new command typed into the editor, in a key and in a header, is written as text and not run either
    const again = await configGet.run({ revisionKey: KEY }, ctx);
    const typed = (again.text ?? "")
      .replace(`"X-A":`, `"X-B": "!touch ${marker("new-header")}", "X-A":`)
      .replace(`"baseUrl":`, `"apiKey2": "!touch ${marker("new-key")}", "baseUrl":`);
    expect(typed).toContain(marker("new-header"));
    expect(typed).toContain(marker("new-key"));
    const second = await configSave.run({ text: typed, baseRevision: again.revision, revisionKey: KEY }, ctx);
    expect(second).toHaveProperty("revision");
    const ran = (
      await Promise.all(FIELDS.map(async (field) => ((await exists(marker(field))) ? field : null)))
    ).filter(Boolean);
    expect(ran).toEqual([]);
    const written = await fs.readFile(join(bed.agentDir, "models.json"), "utf8");
    expect(written).toContain(marker("new-key"));
    expect(written).toContain(marker("new-header"));
    expect(await fs.readFile(join(bed.agentDir, "models.json"), "utf8")).toContain(marker("key"));
  });
});
