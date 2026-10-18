import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ExtensionProviders } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed, modelsJsonWith } from "../../testing/models-bed.ts";
import { writeBridgeLikeExtension } from "../../testing/extensions.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import {
  createExtensionsOp,
  type ExtensionsLoad,
  MAX_EXTENSIONS_BYTES,
  modelsExtensions,
} from "./models-extensions.ts";

const MARKER_KEY = "sk-EXT-MARKER-KEY";
const MARKER_HEADER = "hdr-EXT-MARKER-VALUE";
const MARKER_URL = "https://ext-marker.invalid/v1";

let bed: ModelsBed;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  bed = await makeModelsBed();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  stderr.mockRestore();
  await bed.cleanup();
  expect(blockedAttempts).toEqual([]);
});

const run = (cwd?: string) => modelsExtensions.run({}, bed.context(cwd === undefined ? {} : { cwd }));

async function extensionIn(dir: string, name: string, source: string): Promise<void> {
  await fs.mkdir(join(dir, "extensions"), { recursive: true });
  await fs.writeFile(join(dir, "extensions", name), source);
}
const globalExtension = (source: string, name = "fixture.ts") => extensionIn(bed.agentDir, name, source);

/** A provider registration the way an extension writes it; the key, header and URL are markers that must not come out. */
const registration = (id: string, models: string, extra = "") =>
  `pi.registerProvider(${JSON.stringify(id)}, { name: "Name of ${id}", baseUrl: ${JSON.stringify(MARKER_URL)}, ` +
  `apiKey: ${JSON.stringify(MARKER_KEY)}, api: "openai-completions", headers: { "x-marker": ${JSON.stringify(MARKER_HEADER)} }, ` +
  `models: ${models}${extra} });`;
const modelsOf = (count: number, prefix = "m") =>
  `Array.from({ length: ${count} }, (_, i) => ({ id: "${prefix}" + i, name: "Model " + i, reasoning: i === 0, ` +
  `input: ["text", "image"], contextWindow: 1000 + i, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))`;
/** A runtime stand-in: registering hundreds of real providers is quadratic in Pi (a minute for 300). */
const stand = (ids: string[], models: number, name = "n"): ExtensionsLoad => ({
  extensionsFailed: false,
  selection: async () => ({ offered: new Set(), enabled: null }),
  runtime: {
    getRegisteredProviderIds: () => ids,
    getProvider: (id) => ({ id, name: `Name ${id}` }) as never,
    getModels: (id) =>
      Array.from({ length: models }, (_, i) => ({
        provider: id,
        id: `m${i}`,
        name: `${name}${i}`,
        input: ["text"],
      })) as never,
  },
});
const factory = (body: string) => `export default function (pi) { ${body} }\n`;

describe("models.extensions (helper op)", () => {
  it("takes no params", () => {
    expect(modelsExtensions.params.safeParse({}).success).toBe(true);
    expect(modelsExtensions.params.safeParse({ cwd: "/x" }).success).toBe(false);
  });

  it("extensions.lists: answers the provider an extension registered, with its models", async () => {
    await globalExtension(factory(registration("ext1", modelsOf(2))));
    const result = await run();
    expect(ExtensionProviders.safeParse(result).success).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.providers).toEqual([
      {
        id: "ext1",
        name: "Name of ext1",
        modelsTruncated: false,
        models: [
          {
            provider: "ext1",
            id: "m0",
            name: "Model 0",
            reasoning: true,
            contextWindow: 1000,
            images: true,
            offered: true,
            enabled: true,
          },
          {
            provider: "ext1",
            id: "m1",
            name: "Model 1",
            reasoning: false,
            contextWindow: 1001,
            images: true,
            offered: true,
            enabled: true,
          },
        ],
      },
    ]);
  });

  it("extensions.offered: a model is offered when the no-session rule offers it under the global selection", async () => {
    await globalExtension(factory(registration("ext1", modelsOf(2))));
    const offered = async () =>
      (await run()).providers.flatMap((provider) =>
        provider.models.map((model) => [model.id, model.offered]),
      );
    // No selection: every model of a provider with a key.
    expect(await offered()).toEqual([
      ["m0", true],
      ["m1", true],
    ]);
    // A selection that names one of them.
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["ext1/m1"] });
    expect(await offered()).toEqual([
      ["m0", false],
      ["m1", true],
    ]);
    // A selection of models.json models only: the extension's are outside it.
    await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(1));
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["mine/*"] });
    expect(await offered()).toEqual([
      ["m0", false],
      ["m1", false],
    ]);
  });

  it("extensions.enabled: a model is enabled when the selection names it, offered or not", async () => {
    // A provider with no key: what the selection names is enabled, yet nothing is offered.
    await globalExtension(
      factory(
        `pi.registerProvider("nokey", { baseUrl: "https://x.invalid/v1", api: "openai-completions", ` +
          `models: ${modelsOf(2)} });`,
      ),
    );
    await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(1));
    const flags = async () =>
      (await run()).providers.flatMap((provider) =>
        provider.models.map((model) => [model.id, model.enabled, model.offered]),
      );
    expect(await flags()).toEqual([
      ["m0", true, false],
      ["m1", true, false],
    ]);
    await bed.write(join(bed.agentDir, "settings.json"), { enabledModels: ["mine/*", "nokey/m1"] });
    expect(await flags()).toEqual([
      ["m0", false, false],
      ["m1", true, false],
    ]);
  });

  it("extensions.offered: a project's selection never counts (the op has no project scope)", async () => {
    await globalExtension(factory(registration("ext1", modelsOf(1))));
    await bed.trust(bed.project);
    await bed.write(join(bed.project, ".pi", "settings.json"), { enabledModels: ["nothing/*"] });
    const result = await run(bed.project);
    expect(result.providers[0]?.models[0]?.offered).toBe(true);
  });

  it("extensions.once-per-process: a second load in one process misses a provider that registers once per process", async () => {
    // Why every read runs in a helper of its own (the pool forks one per call): pi-claude-bridge registers at load in
    // the first instance of a process only. This control proves the fixture reproduces it.
    const forget = () => Reflect.deleteProperty(globalThis, Symbol.for("pap-test-bridge:registered"));
    forget();
    try {
      writeBridgeLikeExtension(bed.agentDir);
      const ids = async () => (await run()).providers.map((provider) => provider.id);
      expect(await ids()).toEqual(["pap-test-bridge"]);
      expect(await ids()).toEqual([]);
    } finally {
      // Whatever failed above, the next test of this process starts with no instance registered.
      forget();
    }
  });

  it("extensions.nothing: no extension, no providers, not failed", async () => {
    expect(await run()).toEqual({ providers: [], truncated: false, failed: false });
  });

  it("extensions.no-secret: no key, header value or URL is in the answer", async () => {
    await globalExtension(factory(registration("ext1", modelsOf(1))));
    const text = JSON.stringify(await run());
    for (const secret of [MARKER_KEY, MARKER_HEADER, MARKER_URL, "ext-marker", "x-marker", "baseUrl"])
      expect(text).not.toContain(secret);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(MARKER_KEY);
  });

  it("extensions.failed: an extension that throws gives failed and no guess, even next to a good one", async () => {
    await globalExtension(factory(registration("ext1", modelsOf(2))), "a-good.ts");
    await globalExtension('export default function () { throw new Error("boom sk-LEAK"); }\n', "b-bad.ts");
    const result = await run();
    expect(result).toEqual({ providers: [], truncated: false, failed: true });
    expect(JSON.stringify([result, stderr.mock.calls])).not.toContain("sk-LEAK");
  });

  it("extensions.failed: an extension that does not compile gives failed too", async () => {
    await globalExtension("export default function ( {\n");
    expect(await run()).toEqual({ providers: [], truncated: false, failed: true });
  });

  it("extensions.no-project: a project's .pi/extensions is never loaded, trusted or not", async () => {
    const source = factory(registration("proj-ext", modelsOf(1)));
    // The project of the call, the agent directory itself (the loader's cwd) and a trusted copy of both.
    await extensionIn(join(bed.project, ".pi"), "p.ts", source);
    await extensionIn(join(bed.agentDir, ".pi"), "p.ts", source);
    await globalExtension(factory(registration("global-ext", modelsOf(1))));
    const untrusted = await run(bed.project);
    expect(untrusted.providers.map((provider) => provider.id)).toEqual(["global-ext"]);
    await bed.trust(bed.project);
    await bed.trust(bed.agentDir);
    // Project settings that name an extension file elsewhere: the project scope of the loader's cwd is the agent dir.
    const named = join(bed.root, "named-by-project.ts");
    await fs.writeFile(named, source.replace("proj-ext", "named-ext"));
    for (const dir of [bed.project, bed.agentDir])
      await fs.writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ extensions: [named] }));
    const trusted = await run(bed.project);
    expect(trusted).toEqual(untrusted);
    expect(trusted.failed).toBe(false);
  });

  it("extensions.offline: the extension code runs with PI_OFFLINE on and the variable is put back", async () => {
    const marker = join(bed.root, "offline-marker");
    await globalExtension(
      `import { writeFileSync } from "node:fs";\nexport default function () { ` +
        `writeFileSync(${JSON.stringify(marker)}, String(process.env.PI_OFFLINE)); }\n`,
    );
    vi.stubEnv("PI_OFFLINE", undefined);
    await run();
    expect(await fs.readFile(marker, "utf8")).toBe("1");
    expect(process.env.PI_OFFLINE).toBeUndefined();
  });

  it("extensions.no-builtin: a built-in provider id and a models.json provider never appear", async () => {
    await bed.write(join(bed.agentDir, "models.json"), modelsJsonWith(2));
    await globalExtension(
      factory(registration("anthropic", modelsOf(2)) + registration("ext1", modelsOf(1))),
    );
    const result = await run();
    expect(result.providers.map((provider) => provider.id)).toEqual(["ext1"]);
    expect(result.providers.flatMap((provider) => provider.models.map((model) => model.provider))).toEqual([
      "ext1",
    ]);
  });

  it("extensions.caps-models: 500 models at most per provider, the rest sets modelsTruncated", async () => {
    await globalExtension(factory(registration("big", modelsOf(501)) + registration("exact", modelsOf(500))));
    const result = await run();
    expect(ExtensionProviders.safeParse(result).success).toBe(true);
    const [big, exact] = [result.providers[0], result.providers[1]];
    expect(result.truncated).toBe(false);
    expect(big?.models).toHaveLength(500);
    expect(big?.modelsTruncated).toBe(true);
    expect(exact?.models).toHaveLength(500);
    expect(exact?.modelsTruncated).toBe(false);
  });

  it("extensions.caps-providers: 300 providers at most, the 301st sets truncated", async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `p${i}`);
    const result = await createExtensionsOp(async () => stand(ids, 1)).run({}, bed.context());
    expect(result.providers).toHaveLength(300);
    expect(result.providers.at(-1)?.id).toBe("p299");
    expect(result.truncated).toBe(true);
    expect(ExtensionProviders.safeParse(result).success).toBe(true);
    const exact = await createExtensionsOp(async () => stand(ids.slice(0, 300), 1)).run({}, bed.context());
    expect(exact.providers).toHaveLength(300);
    expect(exact.truncated).toBe(false);
  });

  it("extensions.caps-bytes: the budget stops the list at the first hit, with no empty row after it", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const result = await createExtensionsOp(async () => stand(ids, 500, "N".repeat(250))).run(
      {},
      bed.context(),
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_EXTENSIONS_BYTES);
    expect(result.providers.map((p) => [p.id, p.models.length, p.modelsTruncated])).toEqual([
      ["p0", 500, false],
      ["p1", 500, false],
      ["p2", 500, false],
      ["p3", 182, true],
    ]);
    expect(result.truncated).toBe(true);
    expect(ExtensionProviders.safeParse(result).success).toBe(true);
  });

  it("extensions.caps-lengths: names are clipped at 256, an id that cannot fit is left out, not clipped", async () => {
    const longName = "N".repeat(400);
    const longId = "i".repeat(129);
    await globalExtension(
      factory(
        `pi.registerProvider("named", { name: ${JSON.stringify(longName)}, baseUrl: "https://x.invalid/v1", apiKey: "k", ` +
          `api: "openai-completions", models: [{ id: "m", name: ${JSON.stringify(longName)}, reasoning: false, input: ["text"], ` +
          `contextWindow: 10, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, ` +
          `{ id: ${JSON.stringify("x".repeat(257))}, name: "too long id", reasoning: false, input: ["text"], contextWindow: 10, ` +
          `maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });` +
          registration(longId, modelsOf(1)),
      ),
    );
    const result = await run();
    expect(ExtensionProviders.safeParse(result).success).toBe(true);
    expect(result.providers.map((provider) => provider.id)).toEqual(["named"]);
    expect(result.truncated).toBe(true);
    expect(result.providers[0]?.name).toHaveLength(256);
    expect(result.providers[0]?.models.map((model) => model.id)).toEqual(["m"]);
    // The 257-character model id cannot be listed: the provider says so (carry of task 13).
    expect(result.providers[0]?.modelsTruncated).toBe(true);
    expect(result.providers[0]?.models[0]?.name).toHaveLength(256);
  });

  it("extensions.no-network: loading calls no network", async () => {
    await globalExtension(factory(registration("ext1", modelsOf(1))));
    await run();
    expect(blockedAttempts).toEqual([]);
  });
});
