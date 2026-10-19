import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authHeaderEntries,
  createProviderResolver,
  openRelaySource,
  type RelaySource,
} from "./credentials.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-oauth: accept an OAuth credential -> "refuses an OAuth credential" fails.
 *  - M-http: accept any `http:` base URL -> "refuses an http base URL" fails.
 *  - M-enabled: skip the enabled-models check -> "refuses a provider outside the owner's enabled models" fails.
 */
const now = { value: 0 };
const clock = { now: () => now.value };

function source(
  over: Partial<{
    type: "api_key" | "oauth";
    baseUrl: string;
    apiKey: string | undefined;
    api: string;
    enabled: string[] | null;
    headers: Record<string, string | null>;
  }> = {},
) {
  const calls = { getAuth: 0, open: 0 };
  const open: RelaySource = async () => {
    calls.open += 1;
    return {
      enabled: over.enabled === undefined ? null : new Set(over.enabled),
      runtime: {
        getProvider: (id) =>
          id === "zai" ? { headers: over.headers ?? { "x-org": "acme", "x-null": null } } : undefined,
        getModels: (id) =>
          id === "zai"
            ? [
                {
                  api: over.api ?? "openai-completions",
                  baseUrl: over.baseUrl ?? "https://api.z.ai/api/paas/v4/",
                },
              ]
            : [],
        checkAuth: async (id) => (id === "zai" ? { type: over.type ?? "api_key" } : undefined),
        getAuth: async (id) => {
          calls.getAuth += 1;
          return id === "zai"
            ? { auth: { apiKey: "apiKey" in over ? over.apiKey : "REAL-KEY", headers: { "x-extra": "1" } } }
            : undefined;
        },
      },
    };
  };
  return { open, calls };
}

describe("createProviderResolver", () => {
  it("resolves an API-key provider: api, base URL, credential and the provider's literal headers", async () => {
    const resolve = createProviderResolver({ open: source().open, clock, testLoopback: false });
    expect(await resolve("zai")).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      credential: { value: "REAL-KEY", headers: { "x-org": "acme", "x-extra": "1" } },
    });
  });

  it("refuses an OAuth credential (R9) before it is resolved (M-oauth)", async () => {
    const bed = source({ type: "oauth" });
    const resolve = createProviderResolver({ open: bed.open, clock, testLoopback: false });
    expect(await resolve("zai")).toBeNull();
    expect(bed.calls.getAuth).toBe(0);
  });

  it("refuses an http base URL, a base URL with userinfo, a query or a fragment (M-http)", async () => {
    for (const baseUrl of [
      "http://api.z.ai/v4",
      "http://127.0.0.1:9/v4",
      "https://user:pw@api.z.ai/v4",
      "https://api.z.ai/v4?x=1",
      "https://api.z.ai/v4#f",
      "ftp://api.z.ai",
      "not a url",
    ]) {
      const resolve = createProviderResolver({ open: source({ baseUrl }).open, clock, testLoopback: false });
      expect(await resolve("zai"), baseUrl).toBeNull();
    }
  });

  it("allows loopback http only in test mode", async () => {
    const resolve = createProviderResolver({
      open: source({ baseUrl: "http://127.0.0.1:9/v4" }).open,
      clock,
      testLoopback: true,
    });
    expect((await resolve("zai"))?.baseUrl).toBe("http://127.0.0.1:9/v4");
    const other = createProviderResolver({
      open: source({ baseUrl: "http://api.z.ai/v4" }).open,
      clock,
      testLoopback: true,
    });
    expect(await other("zai")).toBeNull();
  });

  it("refuses a provider outside the owner's enabled models (M-enabled)", async () => {
    const resolve = createProviderResolver({
      open: source({ enabled: ["openai"] }).open,
      clock,
      testLoopback: false,
    });
    expect(await resolve("zai")).toBeNull();
    const allowed = createProviderResolver({
      open: source({ enabled: ["zai"] }).open,
      clock,
      testLoopback: false,
    });
    expect(await allowed("zai")).not.toBeNull();
  });

  it("refuses an unknown provider, an unknown api, no key and an empty key", async () => {
    const resolve = createProviderResolver({ open: source().open, clock, testLoopback: false });
    expect(await resolve("nobody")).toBeNull();
    expect(await resolve("__proto__")).toBeNull();
    for (const over of [{ api: "bedrock-converse-stream" }, { apiKey: undefined }, { apiKey: "" }])
      expect(
        await createProviderResolver({ open: source(over).open, clock, testLoopback: false })("zai"),
      ).toBeNull();
  });

  it("fails closed when Pi's configuration cannot be read", async () => {
    const resolve = createProviderResolver({
      open: async () => {
        throw new Error("sk-LEAK in the message");
      },
      clock,
      testLoopback: false,
    });
    expect(await resolve("zai")).toBeNull();
  });

  it("caches an answer for 60 seconds, never a refusal", async () => {
    const bed = source();
    const resolve = createProviderResolver({ open: bed.open, clock, testLoopback: false });
    now.value = 1_000;
    await resolve("zai");
    now.value = 60_999;
    await resolve("zai");
    expect(bed.calls.open).toBe(1);
    now.value = 61_000;
    await resolve("zai");
    expect(bed.calls.open).toBe(2);
    await resolve("nobody");
    await resolve("nobody");
    expect(bed.calls.open).toBe(4);
  });
});

describe("authHeaderEntries", () => {
  it("keeps string values and drops null, host, cookie and content-length", () => {
    expect(authHeaderEntries({ a: "1", b: null, Host: "h", Cookie: "c", "Content-Length": "1" })).toEqual([
      ["a", "1"],
    ]);
    expect(authHeaderEntries(undefined)).toEqual([]);
  });
});

describe("openRelaySource over Pi's real files", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });
  async function agentDir(files: Record<string, unknown>): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), "relay-cred-"));
    dirs.push(dir);
    for (const [name, value] of Object.entries(files))
      await fs.writeFile(join(dir, name), JSON.stringify(value), { mode: 0o600 });
    return dir;
  }
  const models = {
    providers: {
      zai: {
        baseUrl: "https://api.z.ai/api/paas/v4",
        api: "openai-completions",
        apiKey: "models-json-key",
        headers: { "X-Org": "acme" },
        models: [{ id: "glm-4.6" }],
      },
    },
  };

  it("resolves a models.json key and header, and honours enabledModels", async () => {
    const dir = await agentDir({ "models.json": models, "settings.json": { enabledModels: ["zai/*"] } });
    const resolve = createProviderResolver({
      open: openRelaySource({ agentDir: dir, home: dir }),
      clock,
      testLoopback: false,
    });
    const got = await resolve("zai");
    expect(got?.api).toBe("openai-completions");
    expect(got?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(got?.credential.value).toBe("models-json-key");
    expect(got?.credential.headers["X-Org"] ?? got?.credential.headers["x-org"]).toBe("acme");
  });

  it("refuses a provider the owner did not enable", async () => {
    const dir = await agentDir({ "models.json": models, "settings.json": { enabledModels: ["openai/*"] } });
    const resolve = createProviderResolver({
      open: openRelaySource({ agentDir: dir, home: dir }),
      clock,
      testLoopback: false,
    });
    expect(await resolve("zai")).toBeNull();
  });

  it("resolves the key of auth.json", async () => {
    const dir = await agentDir({
      "models.json": { providers: { zai: { ...models.providers.zai, apiKey: undefined } } },
      "auth.json": { zai: { type: "api_key", key: "auth-json-key" } },
    });
    const resolve = createProviderResolver({
      open: openRelaySource({ agentDir: dir, home: dir }),
      clock,
      testLoopback: false,
    });
    expect((await resolve("zai"))?.credential.value).toBe("auth-json-key");
  });

  it("refuses an OAuth credential of auth.json (R9)", async () => {
    const dir = await agentDir({
      "models.json": { providers: { zai: { ...models.providers.zai, apiKey: undefined } } },
      "auth.json": { zai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 } },
    });
    const resolve = createProviderResolver({
      open: openRelaySource({ agentDir: dir, home: dir }),
      clock,
      testLoopback: false,
    });
    expect(await resolve("zai")).toBeNull();
  });
});
