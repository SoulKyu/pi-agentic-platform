import { describe, expect, it } from "vitest";
import { insertModels, setModelCost } from "./models-json.vm.ts";

/** A JSONC reader for the tests: comments and trailing commas removed, then JSON. Inputs here hold no `//` in strings. */
interface Doc {
  providers: Record<string, { baseUrl?: string; models: Array<Record<string, unknown>> }>;
  [key: string]: unknown;
}
function readJsonc(text: string): Doc {
  const bare = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n"]*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(bare) as Doc;
}

const FILE = `{
  // my gateways
  "providers": {
    "mine": {
      "baseUrl": "http://gateway.test/{v1}//x",
      "models": [
        { "id": "a", "name": "A } ]" } // first
      ]
    },
    "other": { "baseUrl": "http://o.test" }
  }
}
`;

const ids = (value: Doc, provider: string): unknown[] =>
  (value.providers[provider]?.models ?? []).map((model) => model["id"]);

describe("insertModels", () => {
  it("adds models to the provider's array and keeps comments and the rest of the text", () => {
    const result = insertModels(FILE, "mine", [
      { id: "b", contextWindow: 8000, reasoning: true },
      { id: "c" },
    ]);
    expect(result).not.toBeNull();
    expect(result?.added).toBe(2);
    expect(result?.skipped).toBe(0);
    const text = result?.text ?? "";
    expect(text).toContain("// my gateways");
    expect(text).toContain("// first");
    expect(text).toContain('"baseUrl": "http://gateway.test/{v1}//x"');
    expect(text).toContain('"other": { "baseUrl": "http://o.test" }');
    const value = readJsonc(text);
    expect(ids(value, "mine")).toEqual(["a", "b", "c"]);
    expect(value.providers["mine"]?.models[1]).toEqual({ id: "b", contextWindow: 8000, reasoning: true });
  });

  it("skips ids already in the array and says how many", () => {
    const result = insertModels(FILE, "mine", [{ id: "a" }, { id: "b" }]);
    expect(result?.added).toBe(1);
    expect(result?.skipped).toBe(1);
    expect(ids(readJsonc(result?.text ?? ""), "mine")).toEqual(["a", "b"]);
    const none = insertModels(FILE, "mine", [{ id: "a" }]);
    expect(none?.added).toBe(0);
    expect(none?.text).toBe(FILE);
  });

  it("handles an empty array and an array that ends with a comma", () => {
    const empty = insertModels('{"providers":{"p":{"models":[]}}}', "p", [{ id: "x" }]);
    expect(ids(readJsonc(empty?.text ?? ""), "p")).toEqual(["x"]);
    const trailing = insertModels('{"providers":{"p":{"models":[{"id":"y"},]}}}', "p", [{ id: "x" }]);
    expect(ids(readJsonc(trailing?.text ?? ""), "p")).toEqual(["y", "x"]);
  });

  it("adds a models array to a provider without one, a provider to a file without it, and a providers object", () => {
    const noModels = insertModels(FILE, "other", [{ id: "z" }]);
    const value = readJsonc(noModels?.text ?? "");
    expect(ids(value, "other")).toEqual(["z"]);
    expect(value.providers["other"]?.baseUrl).toBe("http://o.test");

    const noProvider = insertModels(FILE, "fresh", [{ id: "z" }]);
    expect(ids(readJsonc(noProvider?.text ?? ""), "fresh")).toEqual(["z"]);
    expect(ids(readJsonc(noProvider?.text ?? ""), "mine")).toEqual(["a"]);

    const noProviders = insertModels('{ "other": 1 }', "fresh", [{ id: "z" }]);
    const parsed = readJsonc(noProviders?.text ?? "");
    expect(parsed["other"]).toBe(1);
    expect(ids(parsed, "fresh")).toEqual(["z"]);
  });

  it("keeps several placeholders in place and in order", () => {
    const masked =
      '{"providers":{"p":{"apiKey":"<redacted:1>","headers":{"x":"<redacted:2>"},"models":[{"id":"a"}],"authHeader":"<redacted:3>"}}}';
    const result = insertModels(masked, "p", [{ id: "b" }, { id: "c" }]);
    const out = result?.text ?? "";
    const at = [1, 2, 3].map((n) => out.indexOf(`"<redacted:${n}>"`));
    expect(at.every((one) => one >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((x, y) => x - y));
    for (const n of [1, 2, 3]) expect(out.split(`<redacted:${n}>`).length).toBe(2);
    const cost = setModelCost(out, "p", "a", { input: 1 }) ?? "";
    for (const n of [1, 2, 3]) expect(cost.split(`<redacted:${n}>`).length).toBe(2);
  });

  it("starts a document when there is no text", () => {
    for (const blank of ["", "  \n"]) {
      const result = insertModels(blank, "mine", [{ id: "z" }]);
      expect(ids(readJsonc(result?.text ?? ""), "mine")).toEqual(["z"]);
    }
  });

  it("refuses text it cannot place the models in, and changes nothing", () => {
    expect(insertModels("{ oops", "mine", [{ id: "z" }])).toBeNull();
    expect(insertModels("[1, 2]", "mine", [{ id: "z" }])).toBeNull();
    expect(insertModels('{"providers": []}', "mine", [{ id: "z" }])).toBeNull();
    expect(insertModels('{"providers": {"mine": {"models": {}}}}', "mine", [{ id: "z" }])).toBeNull();
  });
});

describe("setModelCost", () => {
  it("adds a cost member to the model and keeps the rest", () => {
    const text = setModelCost(FILE, "mine", "a", { input: 3, output: 15, cacheRead: 0.3 });
    expect(text).toContain("// first");
    const value = readJsonc(text ?? "");
    expect(value.providers["mine"]?.models[0]).toEqual({
      id: "a",
      name: "A } ]",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    });
  });

  it("replaces a cost the model already has", () => {
    const start =
      '{"providers":{"p":{"models":[{"id":"m","cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0}}]}}}';
    const value = readJsonc(setModelCost(start, "p", "m", { input: 5, output: 6 }) ?? "");
    expect(value.providers["p"]?.models[0]?.["cost"]).toEqual({
      input: 5,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("answers null when the draft has no such model", () => {
    expect(setModelCost(FILE, "mine", "nope", { input: 1 })).toBeNull();
    expect(setModelCost(FILE, "nope", "a", { input: 1 })).toBeNull();
    expect(setModelCost("{ oops", "mine", "a", { input: 1 })).toBeNull();
  });
});
