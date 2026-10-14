import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { refreshCatalogOp } from "./models-catalog.ts";
import { setDefault, setDefaultThinking } from "./models-defaults.ts";
import { modelsOverview } from "./models-overview.ts";

// A `!command` value is code execution. Each field below would create its own marker file if Pi ran it (MC24).
let bed: ModelsBed;
const marker = (name: string) => join(bed.root, `ran-${name}`);
const exists = (path: string) =>
  fs.stat(path).then(
    () => true,
    () => false,
  );
const FIELDS = [
  "models-key",
  "models-header",
  "auth-key",
  "auth-env",
  "project-key",
  "project-header",
] as const;

const modelsWith = (prefix: string) => ({
  providers: {
    mine: {
      baseUrl: "http://localhost:1/v1",
      apiKey: `!touch ${marker(`${prefix}-key`)}`,
      headers: { "X-A": `!touch ${marker(`${prefix}-header`)}` },
      api: "openai-completions",
      models: [{ id: "m1" }],
    },
  },
});

beforeEach(async () => {
  bed = await makeModelsBed();
  await bed.write(join(bed.agentDir, "models.json"), modelsWith("models"));
  await bed.write(join(bed.agentDir, "auth.json"), {
    anthropic: { type: "api_key", key: `!touch ${marker("auth-key")}` },
    openai: { type: "api_key", env: { OPENAI_ORG: `!touch ${marker("auth-env")}` } },
  });
  // A project's own models.json: Pi reads only the agent directory's, and this must stay true.
  await bed.write(join(bed.project, ".pi", "models.json"), modelsWith("project"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
});

const ran = async () =>
  (await Promise.all(FIELDS.map(async (f) => ((await exists(marker(f))) ? f : null)))).filter(Boolean);

describe("a command value is never run by overview or defaults (MC24)", () => {
  beforeEach(() => vi.stubEnv("PI_OFFLINE", "1"));

  it("overview, with and without a project", async () => {
    const result = await modelsOverview.run({}, bed.context());
    await modelsOverview.run({}, bed.context({ cwd: bed.project }));
    expect(await ran()).toEqual([]);
    expect(result.providers.find((p) => p.id === "anthropic")?.auth).toMatchObject({
      configured: true,
      stored: "api_key",
    });
    expect(result.providers.find((p) => p.id === "openai")?.auth).toMatchObject({ configured: true });
    expect(result.providers.find((p) => p.id === "mine")?.auth.configured).toBe(true);
  });

  it("setDefault and setDefaultThinking", async () => {
    await setDefault.run({ provider: "mine", modelId: "m1" }, bed.context());
    await setDefault.run({ provider: "mine", modelId: "m1" }, bed.context({ cwd: bed.project }));
    await setDefaultThinking.run({ level: "low" }, bed.context());
    expect(await ran()).toEqual([]);
  });
});

describe("the overview never calls Pi's checkAuth (MC25)", () => {
  beforeEach(() => vi.stubEnv("PI_OFFLINE", "1"));
  const authWith = (text: string) => fs.writeFile(join(bed.agentDir, "auth.json"), text);
  const command = () => `!touch ${marker("auth-key")}`;
  const entry = (extra = "") => `{"anthropic":{"type":"api_key","key":"${command()}"}${extra}}`;
  const anthropic = async () =>
    (await modelsOverview.run({}, bed.context())).providers.find((p) => p.id === "anthropic");

  it("reads an auth.json with a leading BOM as Pi does, and runs nothing", async () => {
    await authWith(`\uFEFF${entry()}`);
    expect((await anthropic())?.auth).toMatchObject({ configured: true, stored: "api_key", status: "known" });
    expect(await ran()).toEqual([]);
  });

  it("answers unknown for an auth.json that does not parse, and runs nothing", async () => {
    for (const text of [`{ nope ${command()}`, entry().slice(0, -3), "[]", "null", `\u0000${entry()}`]) {
      await authWith(text);
      expect((await anthropic())?.auth).toMatchObject({ configured: false, stored: null, status: "unknown" });
      expect(await ran()).toEqual([]);
    }
  });

  it("answers unknown for the models.json providers when models.json does not parse, and keeps the built-in ones known", async () => {
    await fs.writeFile(join(bed.agentDir, "models.json"), `{ "providers": { "mine": { "apiKey": "!touch x"`);
    const result = await modelsOverview.run({}, bed.context());
    expect(result.providers.find((p) => p.id === "anthropic")?.auth.status).toBe("known");
    expect(await ran()).toEqual([]);
  });

  it("counts a models.json key as configured and a missing auth.json as known", async () => {
    await fs.rm(join(bed.agentDir, "auth.json"));
    const result = await modelsOverview.run({}, bed.context());
    expect(result.providers.find((p) => p.id === "mine")?.auth).toMatchObject({
      configured: true,
      status: "known",
    });
    expect(result.providers.find((p) => p.id === "anthropic")?.auth).toMatchObject({
      configured: false,
      status: "known",
    });
  });

  it("never calls checkAuth or listCredentials", async () => {
    const proto = (await import("@earendil-works/pi-coding-agent")).ModelRuntime.prototype;
    const check = vi.spyOn(proto, "checkAuth");
    const list = vi.spyOn(proto, "listCredentials");
    await modelsOverview.run({}, bed.context());
    expect(check).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("refresh and commands (MC24)", () => {
  it("never reads a project's own config, trusted or not, and runs no models.json field", async () => {
    vi.stubEnv("PI_OFFLINE", undefined as unknown as string);
    delete process.env.PI_OFFLINE;
    await refreshCatalogOp.run({}, bed.context({ cwd: bed.project }));
    await bed.trust(bed.project);
    await refreshCatalogOp.run({}, bed.context({ cwd: bed.project }));
    const after = await ran();
    expect(after).not.toContain("project-key");
    expect(after).not.toContain("project-header");
    expect(after).not.toContain("models-key");
    expect(after).not.toContain("models-header");
    expect(blockedAttempts).toEqual([]);
  });
});
