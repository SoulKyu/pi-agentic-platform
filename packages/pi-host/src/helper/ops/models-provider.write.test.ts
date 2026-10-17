import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_API_TYPES, type ProviderInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { configGet } from "./models-json.ts";
import { openRuntime } from "./models-open.ts";
import { providerGet, providerSave } from "./models-provider.ts";

const KEY = "ab".repeat(32);
const sha = (text: string) => createHmac("sha256", KEY).update(text).digest("hex");
let bed: ModelsBed;
let file: string;
let outside: string;
beforeEach(async () => {
  bed = await makeModelsBed();
  file = join(bed.agentDir, "models.json");
  outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pap-outside-")));
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await bed.cleanup();
  await fs.rm(outside, { recursive: true, force: true });
  expect(blockedAttempts).toEqual([]);
});
const input = (over: Partial<ProviderInput> = {}): ProviderInput => ({
  id: "mine",
  api: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  auth: { kind: "none" },
  headers: [],
  models: [{ id: "m1", name: "One" }],
  ...over,
});
const revision = async () => (await providerGet.run({ revisionKey: KEY }, bed.context())).revision;
const save = (
  provider: ProviderInput,
  mode: "create" | "update",
  baseRevision: string,
  ctx = bed.context(),
) => providerSave.run({ mode, id: provider.id, provider, baseRevision, revisionKey: KEY }, ctx);
const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as { code?: string },
  );
const stored = async () =>
  JSON.parse(await fs.readFile(file, "utf8")) as { providers: Record<string, Record<string, unknown>> };

describe("models.provider.save", () => {
  it("creates the file when missing with mode 0600, a trailing newline, strict JSON and the matching revision", async () => {
    const result = await save(input(), "create", await revision());
    expect(result).toMatchObject({ revision: sha(await fs.readFile(file, "utf8")) });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const text = await fs.readFile(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      providers: {
        mine: {
          name: undefined,
          api: "openai-completions",
          baseUrl: "http://localhost:11434/v1",
          apiKey: "local-no-key",
          models: [{ id: "m1", name: "One" }],
        },
      },
    });
    expect(result).toMatchObject({
      revision: (await configGet.run({ revisionKey: KEY }, bed.context())).revision,
    });
  });

  it("answers conflict on a stale revision and when the file changed between read and write", async () => {
    const first = await revision();
    await save(input(), "create", first);
    const before = await fs.readFile(file, "utf8");
    expect(await failure(save(input({ id: "two" }), "create", first))).toMatchObject({ code: "conflict" });
    expect(await fs.readFile(file, "utf8")).toBe(before);
    // the file moves while the candidate is validated: the second revision check refuses
    const current = await revision();
    const mkdtemp = fs.mkdtemp.bind(fs) as (prefix: string) => Promise<string>;
    const other = `${before.trimEnd()}\n`.replace('"m1"', '"changed"');
    vi.spyOn(fs, "mkdtemp").mockImplementation((async (prefix: string) => {
      await fs.writeFile(file, other);
      return mkdtemp(prefix);
    }) as never);
    expect(await failure(save(input({ id: "three" }), "create", current))).toMatchObject({
      code: "conflict",
    });
    expect(await fs.readFile(file, "utf8")).toBe(other);
  });

  it("answers not_found for an update of a missing id and config_invalid at $.provider.id for a create of an existing one", async () => {
    await save(input(), "create", await revision());
    expect(await save(input(), "create", await revision())).toEqual({
      code: "config_invalid",
      issues: ["$.provider.id"],
    });
    expect(await failure(save(input({ id: "ghost" }), "update", await revision()))).toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a built-in id with $.provider.id", async () => {
    expect(await save(input({ id: "openai" }), "create", await revision())).toEqual({
      code: "config_invalid",
      issues: ["$.provider.id"],
    });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("save.comments-file: a save on a commented file answers exactly $.file and leaves the bytes", async () => {
    const text = `{\n // mine\n "providers": {},\n}\n`;
    await fs.writeFile(file, text);
    expect(await save(input(), "create", sha(text))).toEqual({ code: "config_invalid", issues: ["$.file"] });
    expect(await fs.readFile(file, "utf8")).toBe(text);
  });

  it("refuses a candidate over the editor's text cap with config_invalid", async () => {
    const pad = "x".repeat(899_000);
    const text = JSON.stringify({ providers: { other: { baseUrl: "https://o.example.com", pad } } });
    await fs.writeFile(file, text);
    const big = input({
      models: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: "n".repeat(256) })),
    });
    expect(await save(big, "create", sha(text))).toEqual({
      code: "config_invalid",
      issues: ["text too large"],
    });
    expect(await fs.readFile(file, "utf8")).toBe(text);
    expect(await save(input(), "create", sha(text))).toMatchObject({ enabledModelsSynced: true });
  });

  it("keeps a key that is a command with keep, and never runs it", async () => {
    const marker = join(outside, "marker");
    await fs.writeFile(
      file,
      JSON.stringify({
        providers: {
          mine: { api: "openai-completions", baseUrl: "http://localhost:1/v1", apiKey: `!touch ${marker}` },
        },
      }),
    );
    await save(input({ auth: { kind: "keep" } }), "update", await revision());
    expect((await stored()).providers.mine?.apiKey).toBe(`!touch ${marker}`);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an invalid candidate that the schema would not build is refused by Pi's loader with $", async () => {
    const bad = input({ models: [{ id: "m1", contextWindow: "big" as never }] });
    expect(await save(bad, "create", await revision())).toEqual({ code: "config_invalid", issues: ["$"] });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps enabledModels covering a model added to a fully enabled provider", async () => {
    await save(input(), "create", await revision());
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["mine/m1"] });
    const result = await save(
      input({ models: [{ id: "m1", name: "One" }, { id: "m2" }] }),
      "update",
      await revision(),
    );
    expect(result).toMatchObject({ enabledModelsSynced: true });
    expect(await bed.read(join(bed.agentDir, "settings.json"))).toEqual({ enabledModels: ["mine/*"] });
  });

  it("save.each-api-type-loads: every api type the form offers loads in Pi's loader", async () => {
    for (const api of PROVIDER_API_TYPES) {
      const id = api.replace(/[^a-z]/g, "").slice(0, 12);
      await save(
        input({ id, api, baseUrl: "https://api.example.com/v1", auth: { kind: "stored" } }),
        "create",
        await revision(),
      );
      const runtime = await openRuntime(bed.context());
      const models = runtime.getModels(id);
      expect(models.length, api).toBeGreaterThan(0);
      for (const model of models) expect(model.api).toBe(api);
    }
  });

  it("refuses a hard-linked models.json and a symlink out of the roots", async () => {
    await fs.writeFile(file, '{"providers":{}}');
    const link = join(bed.agentDir, "alias.json");
    await fs.link(file, link);
    expect(await failure(save(input(), "create", await revision()))).toMatchObject({
      code: "config_hard_link",
    });
    await fs.rm(link);
    await fs.rm(file);
    await fs.writeFile(join(outside, "x"), '{"providers":{}}');
    await fs.symlink(join(outside, "x"), file);
    expect(await failure(save(input(), "create", sha('{"providers":{}}')))).toMatchObject({
      code: "config_path_refused",
    });
    expect(await fs.readFile(join(outside, "x"), "utf8")).toBe('{"providers":{}}');
  });

  it("op-level header guard: a credential-named literal reaches no file", async () => {
    const hostile = input({ headers: [{ name: "X-Api-Key", value: { kind: "literal", text: "sk-1" } }] });
    expect(await save(hostile, "create", await revision())).toEqual({
      code: "config_invalid",
      issues: ["$.provider.headers[0]"],
    });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
