import { describe, expect, it } from "vitest";
import { HTTP_PLAINTEXT_POLICY } from "./base-url.ts";
import {
  AnyProviderId,
  BANNED_HEADERS,
  NO_KEY_LITERAL,
  PROVIDER_API_TYPES,
  ProviderAuthInput,
  ProviderGetHelperParams,
  ProviderGetParams,
  ProviderGetResult,
  ProviderInput,
  ProviderRemoveHelperParams,
  ProviderRemoveParams,
  ProviderSaveHelperParams,
  ProviderSaveParams,
} from "./models-provider-form.ts";

const rev = "a".repeat(64);
const valid = {
  id: "mine",
  api: "openai-completions",
  baseUrl: "https://api.example.com/v1",
  auth: { kind: "stored" },
  headers: [],
  models: [{ id: "m1" }],
};
const withProvider = (patch: Record<string, unknown>) => ({ ...valid, ...patch });
const parses = (patch: Record<string, unknown>) => ProviderInput.safeParse(withProvider(patch)).success;
const header = (name: string, value: unknown) => ({ headers: [{ name, value }] });

describe("ProviderInput", () => {
  it("accepts a plain provider", () => expect(parses({})).toBe(true));

  it("checks the id", () => {
    for (const id of ["Mine", "-x", "a b", "a".repeat(65), "__proto__"])
      expect(parses({ id }), id).toBe(false);
    expect(parses({ id: "constructor" })).toBe(true);
  });

  it("offers the five API types and nothing else", () => {
    expect([...PROVIDER_API_TYPES]).toHaveLength(5);
    for (const api of PROVIDER_API_TYPES) expect(parses({ api })).toBe(true);
    expect(parses({ api: "bedrock-converse-stream" })).toBe(false);
  });

  it("caps the models and refuses a duplicate id at its index", () => {
    expect(parses({ models: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })) })).toBe(true);
    expect(parses({ models: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` })) })).toBe(false);
    const dup = ProviderInput.safeParse(withProvider({ models: [{ id: "a" }, { id: "a" }] }));
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.error.issues.map((i) => i.path.join("."))).toContain("models.1.id");
  });

  it("crosses each length and size cap by one: name 128, literal header value 1024, model id and name 256, numbers", () => {
    const model = (patch: Record<string, unknown>) => ({ models: [{ id: "m1", ...patch }] });
    expect(parses({ name: "n".repeat(128) })).toBe(true);
    expect(parses({ name: "n".repeat(129) })).toBe(false);
    expect(parses(model({ id: "i".repeat(256) }))).toBe(true);
    expect(parses(model({ id: "i".repeat(257) }))).toBe(false);
    expect(parses(model({ name: "n".repeat(256) }))).toBe(true);
    expect(parses(model({ name: "n".repeat(257) }))).toBe(false);
    expect(parses(model({ contextWindow: 100_000_000 }))).toBe(true);
    expect(parses(model({ contextWindow: 100_000_001 }))).toBe(false);
    expect(parses(model({ maxTokens: 10_000_000 }))).toBe(true);
    expect(parses(model({ maxTokens: 10_000_001 }))).toBe(false);
    const literal = (text: string) => header("X-Team", { kind: "literal", text });
    expect(parses(literal("v".repeat(1024)))).toBe(true);
    expect(parses(literal("v".repeat(1025)))).toBe(false);
  });

  it("caps the headers at 8", () => {
    const many = (n: number) => ({
      headers: Array.from({ length: n }, (_, i) => ({
        name: `X-T${i}`,
        value: { kind: "literal", text: "v" },
      })),
    });
    expect(parses(many(8))).toBe(true);
    expect(parses(many(9))).toBe(false);
  });

  it("refuses banned header names", () => {
    expect(BANNED_HEADERS.has("host")).toBe(true);
    for (const name of ["Host", "content-length", "Cookie"])
      expect(parses(header(name, { kind: "literal", text: "v" })), name).toBe(false);
  });

  it("gives a credential-named header an env or keep value only", () => {
    expect(parses(header("X-Api-Key", { kind: "literal", text: "v" }))).toBe(false);
    expect(parses(header("X-Api-Key", { kind: "env", name: "MY_KEY" }))).toBe(true);
    expect(parses(header("X-Api-Key", { kind: "keep" }))).toBe(true);
    expect(parses(header("X-Team", { kind: "literal", text: "red" }))).toBe(true);
    expect(parses(header("X_Team", { kind: "literal", text: "red" }))).toBe(true);
  });

  it("refuses a literal that is a command or interpolates", () => {
    for (const text of ["!ls", "$HOME", "${AWS_SECRET_ACCESS_KEY}", "a$B"])
      expect(parses(header("X-Team", { kind: "literal", text })), text).toBe(false);
  });

  it("allows only printable ASCII in a literal header value, and bans keep-alive and expect", () => {
    for (const text of ["caf\u00e9", "a\u00a0b", "a\u00adb", "\u4e2d"])
      expect(parses(header("X-Team", { kind: "literal", text })), text).toBe(false);
    expect(parses(header("X-Team", { kind: "literal", text: "red ~ blue" }))).toBe(true);
    for (const name of ["Keep-Alive", "expect"]) {
      expect(BANNED_HEADERS.has(name.toLowerCase())).toBe(true);
      expect(parses(header(name, { kind: "literal", text: "v" })), name).toBe(false);
    }
  });

  it("refuses a duplicate header name differing by case", () => {
    const lit = { kind: "literal", text: "v" };
    expect(
      parses({
        headers: [
          { name: "X-Team", value: lit },
          { name: "x-team", value: lit },
        ],
      }),
    ).toBe(false);
  });

  it("can never carry a key: auth is strict", () => {
    expect(parses({ auth: { kind: "stored", key: "x" } })).toBe(false);
    expect(ProviderAuthInput.safeParse({ kind: "env", name: "OPENAI_API_KEY" }).success).toBe(true);
    expect(ProviderAuthInput.safeParse({ kind: "env", name: "1X" }).success).toBe(false);
    expect(ProviderAuthInput.safeParse({ kind: "none" }).success).toBe(true);
  });

  it("refuses an unknown top-level field", () => expect(parses({ apiKey: "sk-1" })).toBe(false));

  it("accepts a LAN baseUrl exactly when the policy is any", () => {
    expect(parses({ baseUrl: "http://192.168.1.50:11434/v1" })).toBe(HTTP_PLAINTEXT_POLICY === "any");
    expect(parses({ baseUrl: "http://localhost:11434/v1" })).toBe(true);
    expect(parses({ baseUrl: "https://u:p@x.example.com" })).toBe(false);
  });

  it("normalises the baseUrl", () => {
    const parsed = ProviderInput.parse(withProvider({ baseUrl: "https://api.example.com/v1/" }));
    expect(parsed.baseUrl).toBe("https://api.example.com/v1");
  });

  it("names the keyless literal", () => expect(NO_KEY_LITERAL).toBe("local-no-key"));
});

describe("ProviderSaveParams and friends", () => {
  const save = { mode: "update", id: "mine", provider: valid, baseRevision: rev };
  it("accepts a save", () => expect(ProviderSaveParams.safeParse(save).success).toBe(true));
  it("refuses create with auth keep", () => {
    const keep = { ...valid, auth: { kind: "keep" } };
    expect(ProviderSaveParams.safeParse({ ...save, mode: "create", provider: keep }).success).toBe(false);
    expect(ProviderSaveParams.safeParse({ ...save, provider: keep }).success).toBe(true);
  });
  it("refuses create with a keep header", () => {
    const provider = { ...valid, ...header("X-Api-Key", { kind: "keep" }) };
    expect(ProviderSaveParams.safeParse({ ...save, mode: "create", provider }).success).toBe(false);
  });
  it("refuses an id that differs from provider.id, and a missing id", () => {
    expect(ProviderSaveParams.safeParse({ ...save, id: "other" }).success).toBe(false);
    expect(ProviderSaveParams.safeParse({ ...save, id: undefined }).success).toBe(false);
  });
  it("remove takes any id the file holds", () => {
    for (const id of ["Mine", "my.local"])
      expect(ProviderRemoveParams.safeParse({ id, baseRevision: rev, alsoRemoveKey: false }).success).toBe(
        true,
      );
    expect(AnyProviderId.safeParse("").success).toBe(false);
  });
  it("get takes nothing or any id, never an empty one", () => {
    expect(ProviderGetParams.safeParse({}).success).toBe(true);
    expect(ProviderGetParams.safeParse({ id: "Mine" }).success).toBe(true);
    expect(ProviderGetParams.safeParse({ id: "" }).success).toBe(false);
  });
  it("get answers editable or a reason", () => {
    expect(
      ProviderGetResult.safeParse({ editable: true, provider: valid, revision: rev, advanced: false })
        .success,
    ).toBe(true);
    expect(
      ProviderGetResult.safeParse({ editable: false, reason: "needs_raw_editor", revision: rev }).success,
    ).toBe(true);
    expect(ProviderGetResult.safeParse({ editable: false, reason: "nope", revision: rev }).success).toBe(
      false,
    );
  });
});

describe("the helper params", () => {
  const key = "b".repeat(64);
  const save = { mode: "create", id: "mine", provider: valid, baseRevision: rev };
  it("take the daemon's revision key and nothing else extra", () => {
    expect(ProviderGetHelperParams.safeParse({ revisionKey: key }).success).toBe(true);
    expect(ProviderGetHelperParams.safeParse({ id: "x", revisionKey: key }).success).toBe(true);
    expect(ProviderGetHelperParams.safeParse({ id: "x" }).success).toBe(false);
    expect(ProviderSaveHelperParams.safeParse({ ...save, revisionKey: key }).success).toBe(true);
    expect(ProviderSaveHelperParams.safeParse(save).success).toBe(false);
    expect(ProviderSaveHelperParams.safeParse({ ...save, id: "other", revisionKey: key }).success).toBe(
      false,
    );
    const remove = { id: "x", baseRevision: rev, alsoRemoveKey: false };
    expect(ProviderRemoveHelperParams.safeParse({ ...remove, revisionKey: key }).success).toBe(true);
    expect(ProviderRemoveHelperParams.safeParse(remove).success).toBe(false);
  });
});
