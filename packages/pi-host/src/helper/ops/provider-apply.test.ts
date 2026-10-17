import { NO_KEY_LITERAL, type ProviderInput } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { applyProvider, parseStrict, removeProvider } from "./provider-apply.ts";

const BUILTIN: ReadonlySet<string> = new Set(["openai", "anthropic"]);
const input = (over: Partial<ProviderInput> = {}): ProviderInput => ({
  id: "mine",
  api: "openai-completions",
  baseUrl: "https://api.example.com/v1",
  auth: { kind: "stored" },
  headers: [],
  models: [],
  ...over,
});
const RICH = {
  providers: {
    mine: {
      name: "Mine",
      api: "openai-completions",
      baseUrl: "http://localhost:1/v1",
      apiKey: "!pass show mine",
      authHeader: true,
      compat: { supportsStore: false },
      modelOverrides: { m1: { name: "Override" } },
      headers: { "X-Team": "red", "X-Secret": "sk-HDR" },
      models: [
        {
          id: "m1",
          name: "One",
          maxTokens: 10,
          cost: { input: 1 },
          thinkingLevelMap: { low: "x" },
          compat: { a: 1 },
        },
        { id: "m2", name: "Two", reasoning: true, cost: { input: 2 } },
      ],
    },
    other: { baseUrl: "https://other.example.com", api: "openai-responses", keep: ["x"] },
  },
};
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const textOf = (applied: ReturnType<typeof applyProvider>): string => {
  if (!("text" in applied)) throw new Error(`no text: ${JSON.stringify(applied)}`);
  return applied.text;
};
const parsed = (text: string) => JSON.parse(text) as { providers: Record<string, Record<string, unknown>> };

describe("save", () => {
  it("keeps-unknown-fields", () => {
    const after = parsed(
      textOf(
        applyProvider(
          json(RICH),
          input({
            name: "Renamed",
            baseUrl: "https://new.example.com/v1",
            auth: { kind: "keep" },
            headers: [
              { name: "X-Team", value: { kind: "literal", text: "red" } },
              { name: "X-Secret", value: { kind: "keep" } },
            ],
            models: [
              { id: "m1", name: "One", maxTokens: 99 },
              { id: "m2", name: "Two", reasoning: true },
            ],
          }),
          "update",
          BUILTIN,
        ),
      ),
    );
    expect(after.providers.mine).toEqual({
      ...RICH.providers.mine,
      name: "Renamed",
      baseUrl: "https://new.example.com/v1",
      models: [{ ...RICH.providers.mine.models[0], maxTokens: 99 }, RICH.providers.mine.models[1]],
    });
  });

  it("other-providers-untouched", () => {
    const after = parsed(
      textOf(applyProvider(json(RICH), input({ auth: { kind: "keep" } }), "update", BUILTIN)),
    );
    expect(after.providers.other).toEqual(RICH.providers.other);
  });

  it("model-merge-by-id", () => {
    const after = parsed(
      textOf(
        applyProvider(
          json(RICH),
          input({
            auth: { kind: "keep" },
            models: [{ id: "new" }, { id: "m2", name: "Two" }, { id: "m1", name: "One" }],
          }),
          "update",
          BUILTIN,
        ),
      ),
    );
    const models = after.providers.mine?.models as Array<Record<string, unknown>>;
    expect(models.map((model) => model.id)).toEqual(["new", "m2", "m1"]);
    expect(models[0]).toEqual({ id: "new" });
    expect(models[1]?.cost).toEqual({ input: 2 });
    expect(models[2]?.thinkingLevelMap).toEqual({ low: "x" });
    expect(models[2]?.compat).toEqual({ a: 1 });
    const removed = parsed(
      textOf(
        applyProvider(
          json(RICH),
          input({ auth: { kind: "keep" }, models: [{ id: "m1" }] }),
          "update",
          BUILTIN,
        ),
      ),
    );
    expect((removed.providers.mine?.models as unknown[]).length).toBe(1);
  });

  it("unset-owned-fields", () => {
    const after = parsed(
      textOf(
        applyProvider(
          json(RICH),
          input({ auth: { kind: "keep" }, models: [{ id: "m2" }] }),
          "update",
          BUILTIN,
        ),
      ),
    );
    const [m2] = after.providers.mine?.models as Array<Record<string, unknown>>;
    expect(m2).toEqual({ id: "m2", cost: { input: 2 } });
  });

  it("refuses-comments", () => {
    for (const text of [
      `// c\n{"providers":{}}`,
      `{"providers":{} /* c */}`,
      `{"providers":{"a":{},}}`,
      `{"providers":{"a":[1,],}}`,
      "[]",
      "nope",
    ]) {
      expect(applyProvider(text, input(), "create", BUILTIN), text).toEqual({ issues: ["$.file"] });
      expect(removeProvider(text, "a", BUILTIN), text).toEqual({ issues: ["$.file"] });
    }
  });

  it("refuses-long-integer", () => {
    const base = (digits: string) => `{"providers":{},"maxRequestBytes":${digits}}`;
    expect(parseStrict(base("12345678901234567"))).toBeNull();
    expect(parseStrict(base("1234567890123456"))).toBeNull();
    expect(parseStrict(base("123456789012345"))).not.toBeNull();
    expect(parseStrict(`{"providers":{},"note":"12345678901234567"}`)).not.toBeNull();
    expect(applyProvider(base("12345678901234567"), input(), "create", BUILTIN)).toEqual({
      issues: ["$.file"],
    });
  });

  it("refuses a number that does not fit a double, and a providers that is not an object", () => {
    for (const text of [`{"providers":{},"n":1e400}`, `{"providers":{},"n":-1e999}`]) {
      expect(parseStrict(text), text).toBeNull();
      expect(applyProvider(text, input(), "create", BUILTIN), text).toEqual({ issues: ["$.file"] });
    }
    expect(parseStrict(`{"n":1e300}`)).not.toBeNull();
    for (const text of [`{"providers":[]}`, `{"providers":"x"}`, `{"providers":null}`]) {
      expect(applyProvider(text, input(), "create", BUILTIN), text).toEqual({ issues: ["$.file"] });
      expect(removeProvider(text, "a", BUILTIN), text).toEqual({ issues: ["$.file"] });
    }
    expect(removeProvider(`{}`, "a", BUILTIN)).toEqual({ fail: "not_found" });
  });

  it("auth", () => {
    const withKey = json({ providers: { mine: { ...RICH.providers.mine, apiKey: "!cmd" } } });
    const apiKey = (kind: ProviderInput["auth"]) =>
      parsed(textOf(applyProvider(withKey, input({ auth: kind }), "update", BUILTIN))).providers.mine?.apiKey;
    expect(apiKey({ kind: "stored" })).toBeUndefined();
    expect(apiKey({ kind: "env", name: "MY_KEY" })).toBe("$MY_KEY");
    expect(apiKey({ kind: "none" })).toBe(NO_KEY_LITERAL);
    expect(apiKey({ kind: "keep" })).toBe("!cmd");
    expect(textOf(applyProvider(withKey, input({ auth: { kind: "keep" } }), "update", BUILTIN))).toContain(
      `"!cmd"`,
    );
    // The revision was current, so the id is taken: a refusal at the id, not a conflict the form would loop on (M3).
    expect(applyProvider(json(RICH), input(), "create", BUILTIN)).toEqual({ issues: ["$.provider.id"] });
    expect(applyProvider(json(RICH), input({ id: "absent" }), "update", BUILTIN)).toEqual({
      fail: "not_found",
    });
    expect(applyProvider(null, input({ id: "openai" }), "create", BUILTIN)).toEqual({
      issues: ["$.provider.id"],
    });
    const full = { providers: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`p${i}`, {}])) };
    expect(applyProvider(json(full), input(), "create", BUILTIN)).toEqual({ issues: ["$.providers"] });
    expect(applyProvider(json(full), input({ id: "p1" }), "update", BUILTIN)).toHaveProperty("text");
  });

  it("creates the file text when there is none, ending with a newline", () => {
    const text = textOf(applyProvider(null, input({ models: [{ id: "a" }] }), "create", BUILTIN));
    expect(text.endsWith("}\n")).toBe(true);
    expect(parsed(text).providers.mine).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      models: [{ id: "a" }],
    });
  });

  it("headers", () => {
    const run = (
      headers: ProviderInput["headers"],
      current: string | null = json(RICH),
      mode: "update" | "create" = "update",
    ) => applyProvider(current, input({ auth: { kind: "keep" }, headers }), mode, BUILTIN);
    const env = parsed(textOf(run([{ name: "X-Org", value: { kind: "env", name: "ORG_ID" } }])));
    expect(env.providers.mine?.headers).toEqual({ "X-Org": "$ORG_ID" });
    const team = parsed(textOf(run([{ name: "X-Team", value: { kind: "literal", text: "blue" } }])));
    expect(team.providers.mine?.headers).toEqual({ "X-Team": "blue" });
    // the op guards independently of the schema (a hand-built input)
    expect(run([{ name: "X-Api-Key", value: { kind: "literal", text: "sk" } }])).toEqual({
      issues: ["$.provider.headers[0]"],
    });
    expect(run([{ name: "X-Team", value: { kind: "literal", text: "a$B" } }])).toEqual({
      issues: ["$.provider.headers[0]"],
    });
    expect(run([{ name: "X-Team", value: { kind: "literal", text: "!ls" } }])).toEqual({
      issues: ["$.provider.headers[0]"],
    });
    const kept = parsed(textOf(run([{ name: "X-Secret", value: { kind: "keep" } }])));
    expect(kept.providers.mine?.headers).toEqual({ "X-Secret": "sk-HDR" });
    expect(run([{ name: "X-Unknown", value: { kind: "keep" } }])).toEqual({
      issues: ["$.provider.headers[0]"],
    });
    expect(parsed(textOf(run([]))).providers.mine).not.toHaveProperty("headers");
  });

  it("prototype-keys", () => {
    const hostile = `{"providers":{"__proto__":{"polluted":true},"other":{"baseUrl":"https://o.example.com"}}}`;
    for (const id of ["constructor", "toString", "hasOwnProperty"]) {
      const text = textOf(applyProvider(hostile, input({ id }), "create", BUILTIN));
      const back = parsed(text);
      expect(Object.hasOwn(back.providers, id)).toBe(true);
      expect(back.providers[id]?.baseUrl).toBe("https://api.example.com/v1");
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    // a prototype name that is not an own key is not "existing"
    expect(applyProvider(hostile, input({ id: "toString" }), "update", BUILTIN)).toEqual({
      fail: "not_found",
    });
    expect(removeProvider(hostile, "constructor", BUILTIN)).toEqual({ fail: "not_found" });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("remove", () => {
  it("removes only that provider; a missing id is not_found; a built-in is refused", () => {
    const after = parsed(textOf(removeProvider(json(RICH), "mine", BUILTIN) as never));
    expect(Object.keys(after.providers)).toEqual(["other"]);
    expect(after.providers.other).toEqual(RICH.providers.other);
    expect(removeProvider(json(RICH), "absent", BUILTIN)).toEqual({ fail: "not_found" });
    expect(removeProvider(json({ other: 1 }), "mine", BUILTIN)).toEqual({ fail: "not_found" });
    expect(removeProvider(json(RICH), "openai", BUILTIN)).toEqual({ issues: ["$.provider.id"] });
  });
});
