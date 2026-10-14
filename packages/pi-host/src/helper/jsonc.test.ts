import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../testing/models-bed.ts";
import { JsoncError, parseJsonc, scanJsonc } from "./jsonc.ts";
import { readSignInFacts } from "./ops/models-open.ts";
import { modelsOverview } from "./ops/models-overview.ts";

const provider = (extra = "") =>
  `"mine": { "baseUrl": "http://localhost:1/v1", // a comment with "quotes" and a // second slash
    "apiKey": "sk-key", "api": "openai-completions", "models": [ { "id": "m1", }, { "id": "m2" }, ],${extra} },`;
const FIXTURES: Record<string, string> = {
  "line comments and trailing commas": `{ // top\n "providers": { ${provider()} }, }\n`,
  "a // inside a string value survives": `{"providers":{"mine":{"baseUrl":"https://example.com//v1","apiKey":"a//b","api":"openai-completions","models":[{"id":"m1"}]}}}`,
  "a leading BOM":
    String.fromCharCode(0xfeff) +
    `{"providers":{"mine":{"baseUrl":"http://x/v1","apiKey":"k","api":"openai-completions","models":[{"id":"m1"}]}}}`,
  "a comment on the last line without a newline": `{"providers":{"mine":{"baseUrl":"http://x/v1","apiKey":"k","api":"openai-completions","models":[{"id":"m1"}]}}} // end`,
  "an escaped quote before a //": `{"providers":{"mine":{"baseUrl":"http://x/v1","apiKey":"a\\"//b","api":"openai-completions","models":[{"id":"m1"}]}}}`,
  "a trailing comma before a closing bracket across lines": `{"providers":{"mine":{"baseUrl":"http://x/v1","apiKey":"k","api":"openai-completions","models":[{"id":"m1"},\n]\n,\n}\n,}}`,
};
const INVALID: Record<string, string> = {
  "a block comment (Pi does not accept it)": `{ /* c */ "providers": {} }`,
  "a truncated file": `{"providers":{"mine":{"apiKey":"k"`,
  "a missing comma": `{"providers":{} "x":1}`,
  "a single quote": `{'providers':{}}`,
};

let bed: ModelsBed;
beforeEach(async () => {
  bed = await makeModelsBed();
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.cleanup();
});

const piLoads = async (text: string) => {
  await fs.writeFile(join(bed.agentDir, "models.json"), text);
  const runtime = await ModelRuntime.create({
    authPath: join(bed.agentDir, "auth.json"),
    modelsPath: join(bed.agentDir, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  return { ok: runtime.getError() === undefined, ids: runtime.getProviders().map((p) => p.id) };
};

describe("parseJsonc mirrors Pi's models.json tolerance", () => {
  it.each(Object.entries(FIXTURES))("accepts %s, as Pi's own loader does", async (_name, text) => {
    const pi = await piLoads(text);
    expect(pi.ok).toBe(true);
    expect(pi.ids).toContain("mine");
    const parsed = parseJsonc(text) as { providers: Record<string, { apiKey?: string }> };
    expect(Object.keys(parsed.providers)).toEqual(["mine"]);
    const facts = await readSignInFacts(bed.context());
    expect(facts.modelsKnown).toBe(true);
    expect([...facts.keyed]).toEqual(["mine"]);
  });

  it("keeps a // inside a string value", () => {
    const parsed = parseJsonc(FIXTURES["a // inside a string value survives"] ?? "") as {
      providers: { mine: { baseUrl: string; apiKey: string } };
    };
    expect(parsed.providers.mine.baseUrl).toBe("https://example.com//v1");
    expect(parsed.providers.mine.apiKey).toBe("a//b");
  });

  it.each(Object.entries(INVALID))("refuses %s, as Pi's own loader does", async (_name, text) => {
    expect((await piLoads(text)).ok).toBe(false);
    expect(() => parseJsonc(text)).toThrow();
    await fs.writeFile(join(bed.agentDir, "models.json"), text);
    expect((await readSignInFacts(bed.context())).modelsKnown).toBe(false);
  });

  it("gives the overview no false warning and an override its key, on a JSONC models.json", async () => {
    await fs.writeFile(
      join(bed.agentDir, "models.json"),
      `{ // mine\n "providers": { ${provider()}\n "anthropic": { "apiKey": "k", }, }, }`,
    );
    const result = await modelsOverview.run({}, bed.context());
    expect(result.enabled.warnings).toEqual([]);
    expect(result.providers.find((p) => p.id === "mine")?.auth).toMatchObject({
      configured: true,
      status: "known",
    });
    expect(result.providers.find((p) => p.id === "anthropic")?.auth).toMatchObject({
      configured: true,
      status: "known",
    });
  });
});

const scan = (text: string) => [...scanJsonc(text)];

describe("scanJsonc", () => {
  it("yields keys and values with offsets that include the quotes, and decoded values", () => {
    const text = `{"a": "x\\"y", "b": {"c": ["d"]}}`;
    const tokens = scan(text);
    expect(tokens.map((t) => [t.role, t.value, t.path])).toEqual([
      ["key", "a", []],
      ["value", 'x"y', ["a"]],
      ["key", "b", []],
      ["key", "c", ["b"]],
      ["value", "d", ["b", "c"]],
    ]);
    expect(text.slice(tokens[1]?.start, tokens[1]?.end)).toBe(`"x\\"y"`);
  });

  it("yields comments (line and block) as their own tokens and never reads a string inside one as a string", () => {
    const text = `{ // "a": "b"\n "c": /* "d" */ "e" }`;
    expect(scan(text).map((t) => [t.role, t.value])).toEqual([
      ["comment", `// "a": "b"`],
      ["key", "c"],
      ["comment", `/* "d" */`],
      ["value", "e"],
    ]);
  });

  it("does not start a comment inside a string", () => {
    expect(scan(`{"u": "http://x/*y*/"}`).map((t) => t.value)).toEqual(["u", "http://x/*y*/"]);
  });

  it("ends a line comment at a newline and at the end of the text", () => {
    expect(scan(`// only`).map((t) => t.value)).toEqual(["// only"]);
  });

  it.each([
    ["an unterminated string", `{"a": "b`, "unterminated string"],
    ["an unterminated block comment", `{ /* "a": "b" }`, "unterminated comment"],
    ["more than 64 levels", "[".repeat(65), "too deep"],
    ["more than 200000 tokens", `[${'"a",'.repeat(200_001)}"a"]`, "too many tokens"],
  ])("throws a JsoncError for %s that quotes nothing of the text", (_name, text, message) => {
    const run = () => scan(text.replace("b", "SECRETPART"));
    expect(run).toThrow(JsoncError);
    expect(run).toThrowError(new RegExp(`^${message}$`));
  });

  it("gives each token its exact pointer, with array indices", () => {
    const text = `{"a": [{"k": "x"}, ["y", "z"]], "b": "w"}`;
    expect(scan(text).map((t) => [t.value, t.pointer])).toEqual([
      ["a", ["a"]],
      ["k", ["a", "0", "k"]],
      ["x", ["a", "0", "k"]],
      ["y", ["a", "1", "0"]],
      ["z", ["a", "1", "1"]],
      ["b", ["b"]],
      ["w", ["b"]],
    ]);
  });

  it("calls a string a key when a colon follows it, so a missing comma cannot hide a credential key", () => {
    const tokens = scan(`{"x": {"baseUrl": "https://h" "apiKey": "sk-1"}}`);
    expect(tokens.map((t) => [t.value, t.role])).toEqual([
      ["x", "key"],
      ["baseUrl", "key"],
      ["https://h", "value"],
      ["apiKey", "key"],
      ["sk-1", "value"],
    ]);
    expect(tokens.at(-1)?.path).toEqual(["x", "apiKey"]);
  });

  it("sees a colon after a comment or a newline", () => {
    expect(scan(`{"a" // c\n : "v"}`).map((t) => t.role)).toEqual(["key", "comment", "value"]);
  });

  it("accepts exactly 64 levels", () => {
    expect(() => scan("[".repeat(64) + "]".repeat(64))).not.toThrow();
  });
});
