import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type Credential, type CredentialStore, type Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HELPER_OPS, PROVIDER_USAGE_IDS, type ProviderUsageId } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HelperContext, HelperOpError } from "../ops.ts";
import { createAuthFileStore } from "./auth-store.ts";
import { createUsageOp, USAGE_BODY_MAX_BYTES, type UsageRuntime } from "./models-usage.ts";
import { RECORDED } from "./models-usage-fixtures.ts";

const ctx = {
  agentDir: "/a",
  papHome: "/p",
  home: "/h",
  signal: new AbortController().signal,
  emit: () => {},
  prompt: async () => null,
} satisfies HelperContext;

const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);

type Auth = Awaited<ReturnType<UsageRuntime["getAuth"]>>;
function runtimeOf(
  id: ProviderUsageId,
  options: { baseUrl?: string | null; modelBaseUrl?: string; auth?: Auth | "throws" } = {},
) {
  const recorded = RECORDED[id];
  const baseUrl = options.baseUrl === undefined ? recorded.baseUrl : (options.baseUrl ?? undefined);
  const getAuth = vi.fn(async () => {
    if (options.auth === "throws") throw new Error("key command failed: sk-LEAK");
    return options.auth === undefined ? { auth: { apiKey: recorded.key } } : options.auth;
  });
  const runtime: UsageRuntime = {
    getProvider: () => ({ baseUrl }),
    getModels: () => (options.modelBaseUrl === undefined ? [] : [{ baseUrl: options.modelBaseUrl }]),
    getAuth,
  };
  return { runtime, getAuth };
}

function run(id: string, runtime: UsageRuntime, fetchImpl: typeof fetch, extra: { timeoutMs?: number } = {}) {
  return createUsageOp({ open: async () => runtime, fetchImpl, ...extra }).run({ providerId: id }, ctx);
}
const never = vi.fn(async () => json({}));
// The operation writes a fixed code to stderr when a query fails; the tests keep the output clean.
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  stderr.mockRestore();
});
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof HelperOpError ? error.code : "other"),
  );

describe("models.usage helper operation", () => {
  it.each(PROVIDER_USAGE_IDS.map((id) => [id]))(
    "%s: asks its pinned endpoint once with the key and normalises the recorded answer",
    async (id) => {
      const recorded = RECORDED[id];
      const { runtime } = runtimeOf(id);
      const fetchImpl = vi.fn(async () => json(recorded.payload));
      const before = Date.now();
      const result = await run(id, runtime, fetchImpl as never);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.report).toMatchObject({
        providerId: id,
        buckets: recorded.buckets,
        metrics: recorded.metrics,
      });
      expect(result.report.capturedAt).toBeGreaterThanOrEqual(before);
      expect(HELPER_OPS["models.usage"].result.parse(result)).toEqual(result);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(recorded.url);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${recorded.key}`);
      expect(JSON.stringify(result)).not.toContain(recorded.key);
    },
  );

  it("sends a stored header the provider's auth gives, never a null one, and never replaces an Authorization it set", async () => {
    const { runtime } = runtimeOf("openai-codex", {
      auth: {
        auth: {
          apiKey: "unused",
          headers: { Authorization: "Bearer oauth-token", "chatgpt-account-id": "acc", x: null },
        },
      },
    });
    const fetchImpl = vi.fn(async () => json(RECORDED["openai-codex"].payload));
    await run("openai-codex", runtime, fetchImpl as never);
    const headers = new Headers((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.get("chatgpt-account-id")).toBe("acc");
    expect(headers.has("x")).toBe(false);
  });

  it("picks MiniMax's endpoint from the key kind", async () => {
    for (const [key, path] of [
      ["sk-api-one", "/account/query_balance"],
      ["sk-cp-two", "/v1/token_plan/remains"],
    ] as const) {
      const { runtime } = runtimeOf("minimax", { auth: { auth: { apiKey: key } } });
      const asked: string[] = [];
      const fetchImpl = async (url: string) => {
        asked.push(url);
        return json(RECORDED["minimax-cn"].payload);
      };
      await run("minimax", runtime, fetchImpl as never);
      expect(asked).toEqual([`https://api.minimax.io${path}`]);
    }
  });

  it("answers unsupported for a provider outside the ten, without opening anything", async () => {
    const open = vi.fn();
    const result = await createUsageOp({ open, fetchImpl: never as never }).run(
      { providerId: "anthropic" },
      ctx,
    );
    expect(result).toEqual({ status: "unsupported" });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("models.usage: the key goes to the official origin only", () => {
  it.each([
    ["a custom host", "https://proxy.example.com/v1"],
    ["plain http", "http://openrouter.ai/api/v1"],
    ["another port", "https://openrouter.ai:8443/api/v1"],
    ["a look-alike host", "https://openrouter.ai.evil.example/api/v1"],
    ["userinfo naming the official host", "https://openrouter.ai@evil.example/api/v1"],
    ["a loopback address", "http://127.0.0.1:8080/v1"],
    ["not a URL", "openrouter"],
  ])("%s: query_failed, no credential resolved and no request", async (_name, baseUrl) => {
    const { runtime, getAuth } = runtimeOf("openrouter", { baseUrl });
    const fetchImpl = vi.fn(async () => json({}));
    expect(await run("openrouter", runtime, fetchImpl as never)).toEqual({ status: "query_failed" });
    expect(getAuth).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the first model's base URL when the provider has none, and judges it the same way", async () => {
    const good = runtimeOf("opencode-go", { baseUrl: null, modelBaseUrl: RECORDED["opencode-go"].baseUrl });
    const fetchImpl = vi.fn(async () => json(RECORDED["opencode-go"].payload));
    expect((await run("opencode-go", good.runtime, fetchImpl as never)).status).toBe("ready");
    const bad = runtimeOf("opencode-go", { baseUrl: null, modelBaseUrl: "https://elsewhere.example/v1" });
    const refused = vi.fn(async () => json({}));
    expect(await run("opencode-go", bad.runtime, refused as never)).toEqual({ status: "query_failed" });
    expect(refused).not.toHaveBeenCalled();
    const none = runtimeOf("opencode-go", { baseUrl: null });
    expect(await run("opencode-go", none.runtime, refused as never)).toEqual({ status: "query_failed" });
  });

  it("refuses a base URL the credential itself carries when it is not the official origin", async () => {
    const { runtime } = runtimeOf("openrouter", {
      auth: { auth: { apiKey: "sk-secret", baseUrl: "https://proxy.example.com/v1" } },
    });
    const fetchImpl = vi.fn(async () => json({}));
    expect(await run("openrouter", runtime, fetchImpl as never)).toEqual({ status: "query_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("models.usage: failures are fixed", () => {
  it("answers auth_unavailable when there is no credential or resolving it throws, never the error's text", async () => {
    const none = runtimeOf("deepseek", { auth: undefined });
    none.getAuth.mockResolvedValueOnce(undefined as never);
    const fetchImpl = vi.fn(async () => json({}));
    expect(await run("deepseek", none.runtime, fetchImpl as never)).toEqual({ status: "auth_unavailable" });
    const throws = runtimeOf("deepseek", { auth: "throws" });
    const result = await run("deepseek", throws.runtime, fetchImpl as never);
    expect(result).toEqual({ status: "auth_unavailable" });
    expect(JSON.stringify(result)).not.toContain("sk-LEAK");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers a 401 as query_failed, carrying neither the body nor the key, and writes neither to stderr", async () => {
    const { runtime } = runtimeOf("openrouter");
    const fetchImpl = vi.fn(async () => new Response("bad key sk-or-secret", { status: 401 }));
    const result = await run("openrouter", runtime, fetchImpl as never);
    expect(result).toEqual({ status: "query_failed" });
    expect(JSON.stringify([result, stderr.mock.calls])).not.toContain("sk-or-secret");
  });

  it("answers a network error, a redirect refusal and a deadline as query_failed", async () => {
    const { runtime } = runtimeOf("openrouter");
    expect(
      await run("openrouter", runtime, (async () => Promise.reject(new TypeError("fetch failed"))) as never),
    ).toEqual({
      status: "query_failed",
    });
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as never;
    expect(await run("openrouter", runtime, hang, { timeoutMs: 1 })).toEqual({ status: "query_failed" });
  });

  it("stops with a fixed failure when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtime } = runtimeOf("openrouter");
    const cancelled = { ...ctx, signal: controller.signal };
    const op = createUsageOp({ open: async () => runtime, fetchImpl: never as never });
    expect(await codeOf(op.run({ providerId: "openrouter" }, cancelled))).toBe("failed");
  });

  it.each([
    [
      "a declared length over the cap",
      () => new Response("{}", { headers: { "content-length": String(USAGE_BODY_MAX_BYTES + 1) } }),
    ],
    ["a stream over the cap", () => new Response(`{"data":"${"x".repeat(USAGE_BODY_MAX_BYTES)}"}`)],
    ["text that is not JSON", () => new Response("<html>sk-or-secret</html>")],
    ["a JSON array", () => new Response("[1,2,3]")],
    ["an object with nothing usable", () => json({ data: { limit: "not a number", usage: -1 } })],
  ])("answers %s as query_failed", async (_name, response) => {
    const { runtime } = runtimeOf("openrouter");
    const result = await run("openrouter", runtime, (async () => response()) as never);
    expect(result).toEqual({ status: "query_failed" });
  });

  it("keeps hostile text out of the report: control and bidi characters go, labels are clipped, buckets stop at 32", async () => {
    const windows = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        index === 0 ? `a‮b\u0000${"z".repeat(100)}` : `w${index}`,
        { percent: index },
      ]),
    );
    const { runtime } = runtimeOf("opencode-go");
    const result = await run("opencode-go", runtime, (async () => json({ usage: windows })) as never);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.report.buckets).toHaveLength(32);
    const first = result.report.buckets[0];
    expect(first?.id).toBe(`ab${"z".repeat(62)}`);
    expect(first?.label).toBe(`ab${"z".repeat(62)}`);
    expect(JSON.stringify(result)).not.toMatch(/\\u202e|\\u0000/i);
  });

  it("loads Pi's configuration offline and says a failure to load in fixed words, never what Pi threw", async () => {
    const before = process.env.PI_OFFLINE;
    let during: string | undefined;
    const open = async () => {
      during = process.env.PI_OFFLINE;
      throw new Error("Cannot find package 'leaky-package' sk-LEAK");
    };
    const op = createUsageOp({ open, fetchImpl: never as never });
    const error = await op.run({ providerId: "openrouter" }, ctx).catch((thrown: unknown) => thrown);
    expect(during).toBe("1");
    expect(process.env.PI_OFFLINE).toBe(before);
    expect(error).toBeInstanceOf(HelperOpError);
    expect((error as HelperOpError).code).toBe("failed");
    expect((error as HelperOpError).message).not.toContain("leaky-package");
    expect((error as HelperOpError).message).not.toContain("sk-LEAK");
  });
});

describe("models.usage: an expired OAuth credential", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function oauthProvider(refresh: ReturnType<typeof vi.fn>): Provider {
    const faux = fauxProvider({ api: "usage-faux", provider: "openrouter", models: [{ id: "m" }] });
    return {
      ...faux.provider,
      baseUrl: RECORDED.openrouter.baseUrl,
      auth: {
        oauth: {
          name: "Test OAuth",
          login: async () => {
            throw new Error("not used");
          },
          refresh: refresh as never,
          toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
        },
      },
    } as Provider;
  }

  it("is refreshed once by Pi, written to auth.json once under the store's lock, and the new token is what is sent", async () => {
    dir = await mkdtemp(join(tmpdir(), "pap-usage-"));
    const expired: Credential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 };
    await writeFile(join(dir, "auth.json"), JSON.stringify({ openrouter: expired }), { mode: 0o600 });
    const real = createAuthFileStore({ agentDir: dir, home: dir });
    let writes = 0;
    const store: CredentialStore = {
      ...real,
      modify: (providerId, fn, options) =>
        real.modify(
          providerId,
          async (current) => {
            const next = await fn(current);
            if (next !== undefined) writes += 1;
            return next;
          },
          options,
        ),
    };
    const refresh = vi.fn(async () => ({
      type: "oauth" as const,
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 3_600_000,
    }));
    const runtime = await ModelRuntime.create({
      credentials: store,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(oauthProvider(refresh));
    const fetchImpl = vi.fn(async () => json(RECORDED.openrouter.payload));
    const result = await run("openrouter", runtime, fetchImpl as never);
    expect(result.status).toBe("ready");
    expect(refresh).toHaveBeenCalledOnce();
    expect(writes).toBe(1);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer new-access");
    const written = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as Record<
      string,
      { access: string }
    >;
    expect(written.openrouter?.access).toBe("new-access");
    expect((await stat(join(dir, "auth.json"))).mode & 0o777).toBe(0o600);
    await expect(stat(join(dir, "auth.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    // A second question finds a fresh token: no second refresh, no second write.
    await run("openrouter", runtime, fetchImpl as never);
    expect(refresh).toHaveBeenCalledOnce();
    expect(writes).toBe(1);
    expect(JSON.stringify(result)).not.toContain("access");
  });
});
