import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { HTTP_PLAINTEXT_POLICY, ProviderGetResult } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import { blockedAttempts } from "../../testing/network-guard.ts";
import { providerGet, providerRemove } from "./models-provider.ts";

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
const put = (providers: Record<string, unknown>) =>
  fs.writeFile(file, JSON.stringify({ providers }, null, 2));
const get = (id?: string) =>
  providerGet.run({ ...(id === undefined ? {} : { id }), revisionKey: KEY }, bed.context());
const remove = (id: string, baseRevision: string) =>
  providerRemove.run({ id, baseRevision, alsoRemoveKey: false, revisionKey: KEY }, bed.context());
const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as { code?: string },
  );
const OK = { api: "openai-completions", baseUrl: "http://localhost:11434/v1" };

describe("models.provider.get", () => {
  it("answers the form view, with a secret literal as keep and never as a value", async () => {
    await put({
      mine: {
        ...OK,
        name: "Mine",
        apiKey: "sk-LITERAL",
        headers: {
          "X-Api-Key": "sk-HDR",
          "X-Team": "red",
          "X-Client-Id": "client-LITERAL-4242",
          "X-Org": "$ORG",
        },
        models: [{ id: "m1", name: "One", input: ["text", "image"], maxTokens: 5 }],
      },
    });
    const result = await get("mine");
    expect(ProviderGetResult.parse(result)).toMatchObject({
      editable: true,
      advanced: false,
      provider: {
        id: "mine",
        auth: { kind: "keep" },
        headers: [
          { name: "X-Api-Key", value: { kind: "keep" } },
          { name: "X-Team", value: { kind: "keep" } },
          { name: "X-Client-Id", value: { kind: "keep" } },
          { name: "X-Org", value: { kind: "env", name: "ORG" } },
        ],
      },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("sk-LITERAL");
    expect(text).not.toContain("sk-HDR");
    // M7R62: no header value leaves the helper, whatever its name
    expect(text).not.toContain("client-LITERAL-4242");
    expect(text).not.toContain("red");
  });

  it("advanced is true for an unowned key of the provider or of a model", async () => {
    await put({
      a: { ...OK, compat: {} },
      b: { ...OK, models: [{ id: "m", cost: { input: 1 } }] },
      c: { ...OK },
    });
    expect(await get("a")).toMatchObject({ editable: true, advanced: true });
    expect(await get("b")).toMatchObject({ editable: true, advanced: true });
    expect(await get("c")).toMatchObject({ editable: true, advanced: false });
  });

  it("answers not_in_file with the revision when no id is given or the id is absent, on a missing or a plain file", async () => {
    expect(await get()).toEqual({ editable: false, reason: "not_in_file", revision: sha("") });
    expect(await get("x")).toMatchObject({ editable: false, reason: "not_in_file" });
    await put({ a: OK });
    expect(await get()).toEqual({
      editable: false,
      reason: "not_in_file",
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await get("absent")).toMatchObject({ reason: "not_in_file" });
    // a prototype name is not an own key
    for (const id of ["__proto__", "constructor", "toString"])
      expect(await get(id), id).toMatchObject({ editable: false, reason: "not_in_file" });
  });

  it("get.comments-file: a comment, a trailing comma or a long integer answers needs_raw_editor for every id", async () => {
    for (const text of [
      `{ // note\n "providers": { "mine": ${JSON.stringify(OK)} } }`,
      `{ "providers": { "mine": ${JSON.stringify(OK)}, } }`,
      `{ "providers": { "mine": ${JSON.stringify(OK)} }, "n": 12345678901234567 }`,
      "[]",
    ]) {
      await fs.writeFile(file, text);
      for (const id of ["mine", "other", "openai"])
        expect(await get(id), text).toEqual({
          editable: false,
          reason: "needs_raw_editor",
          revision: sha(text),
        });
      expect(await get(), text).toEqual({ editable: false, reason: "needs_raw_editor", revision: sha(text) });
    }
  });

  it("a non-object providers, or a number that does not fit a double, is needs_raw_editor on get, save and remove", async () => {
    for (const text of [
      `{"providers":[]}`,
      `{"providers":"x"}`,
      `{"providers":null}`,
      `{"providers":{},"n":1e400}`,
    ]) {
      await fs.writeFile(file, text);
      expect(await get("a"), text).toEqual({
        editable: false,
        reason: "needs_raw_editor",
        revision: sha(text),
      });
      expect(await get(), text).toMatchObject({ reason: "needs_raw_editor" });
      expect(await remove("a", sha(text)), text).toEqual({ code: "config_invalid", issues: ["$.file"] });
    }
  });

  it("get.stored-key: tells the form that auth.json holds a credential for this id or, with no id, for which ids, and never its value", async () => {
    const authPath = join(bed.agentDir, "auth.json");
    await fs.writeFile(
      authPath,
      JSON.stringify({
        mine: { type: "api_key", key: "sk-STORED-1" },
        old: { type: "api_key", key: "sk-STORED-2" },
      }),
    );
    await put({ mine: OK, other: OK });
    expect(await get("mine")).toMatchObject({ editable: true, keyStored: true });
    expect((await get("other")) as object).not.toHaveProperty("keyStored");
    const fresh = await get();
    expect(fresh).toMatchObject({ editable: false, reason: "not_in_file", storedKeys: ["mine", "old"] });
    expect(JSON.stringify([fresh, await get("mine")])).not.toContain("sk-STORED");
    expect(ProviderGetResult.safeParse(fresh).success).toBe(true);
  });

  it("get.stored-key: a damaged auth.json does not stop the form from opening", async () => {
    await fs.writeFile(join(bed.agentDir, "auth.json"), "{ not json");
    await put({ mine: OK });
    expect(await get("mine")).toMatchObject({ editable: true });
    expect(await get("mine")).not.toHaveProperty("keyStored");
    expect(await get()).toEqual({ editable: false, reason: "not_in_file", revision: expect.any(String) });
  });

  it("answers builtin for a built-in id", async () => {
    await put({ a: OK });
    expect(await get("openai")).toMatchObject({ editable: false, reason: "builtin" });
  });

  it("get.degrades: a provider the form did not write is editable:false, never an error, and parses", async () => {
    await put({
      lan: { api: "openai-completions", baseUrl: "http://192.168.1.5:11434/v1" },
      query: { api: "openai-completions", baseUrl: "https://x.example.com/v1?api-version=1" },
      Mine: { ...OK },
      "my.local": { ...OK },
      oddheader: { ...OK, headers: { X_Foo: "v" } },
      audio: { ...OK, models: [{ id: "a", input: ["audio"] }] },
      bogus: { api: "bogus", baseUrl: "https://x.example.com" },
      nourl: { api: "openai-completions" },
      weird: "text",
    });
    const lanExpected =
      HTTP_PLAINTEXT_POLICY === "loopback"
        ? { editable: false, reason: "url_unsupported" }
        : { editable: true };
    const expected: Record<string, unknown> = {
      lan: lanExpected,
      query: { editable: false, reason: "url_unsupported" },
      Mine: { editable: false, reason: "needs_raw_editor" },
      "my.local": { editable: false, reason: "needs_raw_editor" },
      oddheader: { editable: true },
      audio: { editable: false, reason: "needs_raw_editor" },
      bogus: { editable: false, reason: "api_unsupported" },
      nourl: { editable: false, reason: "needs_raw_editor" },
      weird: { editable: false, reason: "needs_raw_editor" },
    };
    for (const [id, want] of Object.entries(expected)) {
      const result = await get(id);
      expect(result, id).toMatchObject(want as object);
      expect(ProviderGetResult.safeParse(result).success, id).toBe(true);
    }
  });
});

describe("models.provider.remove", () => {
  it("remove.any-id: removes an uppercase id, a dotted id and a provider the form cannot edit", async () => {
    await put({
      Mine: { ...OK },
      "my.local": { ...OK },
      lan: { api: "openai-completions", baseUrl: "http://192.168.1.5:11434/v1" },
      keep: { ...OK, compat: { a: 1 } },
    });
    for (const id of ["Mine", "my.local", "lan"]) {
      const { revision } = await get();
      const result = await remove(id, revision);
      expect(result).toMatchObject({ revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(
        Object.keys((JSON.parse(await fs.readFile(file, "utf8")) as { providers: object }).providers),
      ).not.toContain(id);
    }
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      providers: { keep: { ...OK, compat: { a: 1 } } },
    });
    const { revision } = await get();
    expect(await failure(remove("absent", revision))).toMatchObject({ code: "not_found" });
    expect(await remove("openai", revision)).toEqual({ code: "config_invalid", issues: ["$.provider.id"] });
    for (const id of ["__proto__", "constructor"])
      expect(await failure(remove(id, revision)), id).toMatchObject({ code: "not_found" });
  });

  it("answers a stale revision as conflict and a commented file as config_invalid $.file, leaving the file untouched", async () => {
    await put({ a: OK });
    const { revision } = await get();
    await put({ a: OK, b: OK });
    expect(await failure(remove("a", revision))).toMatchObject({ code: "conflict" });
    const text = `{ // c\n "providers": { "a": ${JSON.stringify(OK)} } }`;
    await fs.writeFile(file, text);
    expect(await remove("a", sha(text))).toEqual({ code: "config_invalid", issues: ["$.file"] });
    expect(await fs.readFile(file, "utf8")).toBe(text);
  });
});
