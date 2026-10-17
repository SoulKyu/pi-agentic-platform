import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { MODELS_CONFIG_TEXT_MAX, type ProviderInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { configGet } from "./models-json.ts";
import { providerRemove, providerSave } from "./models-provider.ts";

const KEY = "ab".repeat(32);
const sha = (text: string) => createHmac("sha256", KEY).update(text).digest("hex");
let bed: ModelsBed;
let file: string;
beforeEach(async () => {
  bed = await makeModelsBed();
  file = join(bed.agentDir, "models.json");
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
  expect(blockedAttempts).toEqual([]);
});
const OK = { api: "openai-completions", baseUrl: "http://localhost:11434/v1" };
const input: ProviderInput = {
  id: "mine",
  api: "openai-completions",
  baseUrl: "http://localhost:11434/v1",
  auth: { kind: "none" },
  headers: [],
  models: [{ id: "m1" }],
};
const escapedLength = (text: string) => Buffer.byteLength(JSON.stringify(text));

/** Many tiny models: a compact file is small, the pretty-printed one is several times larger, and every quote counts twice once the editor carries it as JSON. */
const crowded = (count: number) => ({
  other: { ...OK, models: Array.from({ length: count }, (_, i) => ({ id: `m${i}` })) },
});

describe("one size predicate for configGet, provider save and provider remove", () => {
  it("remove.grows-file: a compact file under the cap whose rewrite is over it is refused, file untouched", async () => {
    const compact = JSON.stringify({ providers: { ...crowded(17_500), mine: OK } });
    const pretty = JSON.stringify({ providers: { ...crowded(17_500) } }, null, 2) + "\n";
    // The preconditions of the test itself: the old file fits, the rewrite does not (JSON-escaped), though its raw bytes do.
    expect(compact.length).toBeLessThan(MODELS_CONFIG_TEXT_MAX);
    expect(Buffer.byteLength(pretty)).toBeLessThan(MODELS_CONFIG_TEXT_MAX);
    expect(escapedLength(pretty)).toBeGreaterThan(MODELS_CONFIG_TEXT_MAX);
    await fs.writeFile(file, compact);
    const result = await providerRemove.run(
      { id: "mine", baseRevision: sha(compact), alsoRemoveKey: false, revisionKey: KEY },
      bed.context(),
    );
    expect(result).toEqual({ code: "config_invalid", issues: ["text too large"] });
    expect(await fs.readFile(file, "utf8")).toBe(compact);
  });

  it("save.escaped-length: raw bytes under the cap, JSON-escaped length over it, is refused", async () => {
    const before = JSON.stringify({ providers: crowded(17_500) });
    await fs.writeFile(file, before);
    const result = await providerSave.run(
      { mode: "create", id: "mine", provider: input, baseRevision: sha(before), revisionKey: KEY },
      bed.context(),
    );
    const after = await fs.readFile(file, "utf8");
    // Either outcome must agree with the predicate: refused only when the escaped length is over the cap.
    const candidate = JSON.stringify({ providers: { ...crowded(17_500), mine: {} } }, null, 2);
    expect(escapedLength(candidate)).toBeGreaterThan(MODELS_CONFIG_TEXT_MAX);
    expect(Buffer.byteLength(candidate)).toBeLessThan(MODELS_CONFIG_TEXT_MAX);
    expect(result).toEqual({ code: "config_invalid", issues: ["text too large"] });
    expect(after).toBe(before);
  }, 30_000);

  it("configGet uses the same predicate: a file whose masked text is over the cap when escaped is not shown, with the issue", async () => {
    const text = JSON.stringify({ providers: crowded(17_500) }, null, 2);
    expect(Buffer.byteLength(text)).toBeLessThan(MODELS_CONFIG_TEXT_MAX);
    expect(escapedLength(text)).toBeGreaterThan(MODELS_CONFIG_TEXT_MAX);
    await fs.writeFile(file, text);
    expect(await configGet.run({ revisionKey: KEY }, bed.context())).toEqual({
      text: null,
      issues: ["text too large"],
      revision: sha(text),
      path: file,
    });
  });

  it("a rewrite that fits is saved", async () => {
    const compact = JSON.stringify({ providers: { ...crowded(10), mine: OK } });
    await fs.writeFile(file, compact);
    expect(
      await providerRemove.run(
        { id: "mine", baseRevision: sha(compact), alsoRemoveKey: false, revisionKey: KEY },
        bed.context(),
      ),
    ).toMatchObject({ revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
