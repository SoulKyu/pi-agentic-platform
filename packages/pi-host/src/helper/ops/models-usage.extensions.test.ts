import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type Credential, type CredentialStore, type Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperContext } from "../ops.ts";
import { createAuthFileStore } from "./auth-store.ts";
import { createUsageOp } from "./models-usage.ts";
import { RECORDED } from "./models-usage-fixtures.ts";

const json = (value: unknown) => new Response(JSON.stringify(value));
let dir: string;
let stderr: ReturnType<typeof vi.spyOn>;
const ctxOf = (): HelperContext => ({
  agentDir: dir,
  papHome: dir,
  home: dir,
  signal: new AbortController().signal,
  emit: () => {},
  prompt: async () => null,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pap-usage-ext-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-secret" } }),
    { mode: 0o600 },
  );
});
afterEach(async () => {
  stderr.mockRestore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

async function extension(source: string): Promise<void> {
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(join(dir, "extensions", "fixture.ts"), source);
}
const ask = (fetchImpl: typeof fetch) =>
  createUsageOp({ fetchImpl }).run({ providerId: "openrouter" }, ctxOf());

describe("models.usage with the owner's extensions", () => {
  it("works as before when no extension touches the provider", async () => {
    await extension("export default function () {}\n");
    const fetchImpl = vi.fn(async () => json(RECORDED.openrouter.payload));
    expect((await ask(fetchImpl as never)).status).toBe("ready");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses, resolves no key and sends nothing when an extension repoints the provider", async () => {
    await extension(
      'export default function (pi) { pi.registerProvider("openrouter", { baseUrl: "http://127.0.0.1:9/v1" }); }\n',
    );
    const fetchImpl = vi.fn(async () => json(RECORDED.openrouter.payload));
    expect(await ask(fetchImpl as never)).toEqual({ status: "provider_overridden" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when an extension fails to load", async () => {
    await extension('export default function () { throw new Error("boom sk-LEAK"); }\n');
    const fetchImpl = vi.fn(async () => json(RECORDED.openrouter.payload));
    const result = await ask(fetchImpl as never);
    expect(result).toEqual({ status: "extensions_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify([result, stderr.mock.calls])).not.toContain("sk-LEAK");
  });
});

describe("models.usage: a slow OAuth refresh", () => {
  it("is not cut by the usage deadline: the new token is written and the query goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const expired: Credential = { type: "oauth", access: "old", refresh: "old-r", expires: 1 };
    await writeFile(join(dir, "auth.json"), JSON.stringify({ openrouter: expired }), { mode: 0o600 });
    const store: CredentialStore = createAuthFileStore({ agentDir: dir, home: dir });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const refresh = vi.fn(async () => {
      await gate;
      return { type: "oauth" as const, access: "new", refresh: "new-r", expires: Date.now() + 3_600_000 };
    });
    const faux = fauxProvider({ api: "usage-faux", provider: "openrouter", models: [{ id: "m" }] });
    const provider = {
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
    const runtime = await ModelRuntime.create({
      credentials: store,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(provider);
    const fetchImpl = vi.fn(async () => json(RECORDED.openrouter.payload));
    const pending = createUsageOp({
      open: async () => runtime,
      fetchImpl: fetchImpl as never,
      timeoutMs: 5,
    }).run({ providerId: "openrouter" }, ctxOf());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);
    release();
    expect((await pending).status).toBe("ready");
    const written = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as Record<
      string,
      { access: string }
    >;
    expect(written.openrouter?.access).toBe("new");
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer new");
  });
});
