import { join } from "node:path";
import { ModelsDiscoverResult, ModelsTestResult } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeModelsBed, type ModelsBed } from "../../testing/models-bed.ts";
import {
  completionStream,
  type ProviderFixture,
  startProviderFixture,
} from "../../testing/provider-fixture.ts";
import { HelperOpError } from "../ops.ts";
import {
  createDiscoverOp,
  createTestOp,
  failureClass,
  modelsDiscover,
  modelsTest,
} from "./models-discover.ts";

// Loopback fixture, no outside network; this file does not load the network guard (it refuses loopback too).
const KEY = "sk-DISCOVER-KEY-1234";
let bed: ModelsBed;
let fixture: ProviderFixture;

beforeEach(async () => {
  bed = await makeModelsBed();
  fixture = await startProviderFixture();
  vi.stubEnv("PI_OFFLINE", "1");
  await bed.write(join(bed.agentDir, "models.json"), {
    providers: {
      mine: {
        name: "Mine",
        baseUrl: fixture.baseUrl,
        apiKey: KEY,
        api: "openai-completions",
        models: [{ id: "m1", name: "Model 1" }],
      },
    },
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.close();
  await bed.cleanup();
});

const discover = (provider = "mine") => modelsDiscover.run({ provider }, bed.context());
const test = (modelId = "m1", provider = "mine") => modelsTest.run({ provider, modelId }, bed.context());
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof HelperOpError ? error.code : "other"),
  );

describe("models.discover", () => {
  it("copies only contextWindow, maxTokens and reasoning:true from a discovered entry", async () => {
    fixture.reply("GET /v1/models", {
      body: {
        data: [
          {
            id: "gw-1",
            name: "Gateway One",
            contextWindow: 32000,
            maxTokens: 2048,
            reasoning: true,
            context_length: 999,
            pricing: { prompt: "0.1" },
            owned_by: "someone",
            api_key: "sk-LEAK-IN-LISTING",
          },
          { id: "gw-2", contextWindow: -5, maxTokens: 1.5, reasoning: "yes" },
          { id: "gw-3", reasoning: false },
        ],
      },
    });
    const result = await discover();
    expect(result).toEqual({
      models: [
        { id: "gw-1", contextWindow: 32000, maxTokens: 2048, reasoning: true },
        { id: "gw-2" },
        { id: "gw-3" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("sk-LEAK");
    expect(ModelsDiscoverResult.safeParse(result).success).toBe(true);
  });

  it("sends one GET <baseUrl>/models with the provider's key, and nothing else", async () => {
    fixture.reply("GET /v1/models", { body: { data: [] } });
    expect(await discover()).toEqual({ models: [] });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ method: "GET", url: "/v1/models" });
    expect(fixture.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("accepts a bare array and a { models } list, drops duplicates and ids that are not text", async () => {
    fixture.reply("GET /v1/models", {
      body: [{ id: "a" }, { id: "a" }, { id: 7 }, { id: "" }, "b", { id: "c" }],
    });
    expect(await discover()).toEqual({ models: [{ id: "a" }, { id: "c" }] });
    fixture.reply("GET /v1/models", { body: { models: [{ id: "z" }] } });
    expect(await discover()).toEqual({ models: [{ id: "z" }] });
  });

  it("keeps at most 2000 models", async () => {
    fixture.reply("GET /v1/models", {
      body: { data: Array.from({ length: 2500 }, (_, i) => ({ id: `m${i}` })) },
    });
    expect((await discover()).models).toHaveLength(2000);
  });

  it("reduces a failure to a status class and never forwards the provider's body", async () => {
    fixture.reply("GET /v1/models", { status: 401, body: { error: `bad key ${KEY}` } });
    const denied = await discover();
    expect(denied).toEqual({ models: [], code: "http_4xx" });
    fixture.reply("GET /v1/models", { status: 503, body: `upstream said ${KEY}` });
    expect(await discover()).toEqual({ models: [], code: "http_5xx" });
    expect(JSON.stringify([denied])).not.toContain(KEY);
  });

  it("does not follow a redirect with the key", async () => {
    fixture.reply("GET /v1/models", { status: 302, headers: { location: "/v1/elsewhere" } });
    fixture.reply("GET /v1/elsewhere", { body: { data: [{ id: "x" }] } });
    expect(await discover()).toEqual({ models: [], code: "network" });
    expect(fixture.requests.map((r) => r.url)).toEqual(["/v1/models"]);
  });

  it("answers network when nothing listens, and for a body that is not JSON", async () => {
    fixture.reply("GET /v1/models", { body: "<html>not json</html>" });
    expect(await discover()).toEqual({ models: [], code: "network" });
    await fixture.close();
    expect(await discover()).toEqual({ models: [], code: "network" });
  });

  it("answers timeout when the provider does not answer in time", async () => {
    fixture.reply("GET /v1/models", { hang: true });
    const op = createDiscoverOp({ timeoutMs: 40 });
    expect(await op.run({ provider: "mine" }, bed.context())).toEqual({ models: [], code: "timeout" });
  });

  it("refuses a provider that does not exist", async () => {
    expect(await codeOf(discover("nope"))).toBe("not_found");
    expect(fixture.requests).toHaveLength(0);
  });

  it("refuses a body over the cap without keeping it", async () => {
    fixture.reply("GET /v1/models", { body: `{"data":[{"id":"${"x".repeat(5 * 1024 * 1024)}"}]}` });
    expect(await discover()).toEqual({ models: [], code: "network" });
  });
});

describe("models.discover: byte budget, keyless fallback, cross-origin redirect", () => {
  it("cuts a list over the byte budget and says so (truncated)", async () => {
    // 2000 ids of 256 two-byte characters weigh about 1.1 MB once serialised.
    const id = (i: number) => `${"\u00e9".repeat(250)}${String(i).padStart(6, "0")}`;
    fixture.reply("GET /v1/models", {
      body: { data: Array.from({ length: 2000 }, (_, i) => ({ id: id(i) })) },
    });
    const result = await discover();
    expect(result.truncated).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.length).toBeLessThan(2000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(800_000);
    expect(ModelsDiscoverResult.safeParse(result).success).toBe(true);
  });

  it("does not set truncated for a small list", async () => {
    fixture.reply("GET /v1/models", { body: { data: [{ id: "a" }] } });
    expect(await discover()).toEqual({ models: [{ id: "a" }] });
  });

  it("asks without a key when Pi cannot resolve one, and notes a fixed code on stderr", async () => {
    await bed.write(join(bed.agentDir, "models.json"), {
      providers: {
        mine: {
          name: "Mine",
          baseUrl: fixture.baseUrl,
          apiKey: "!exit 3",
          api: "openai-completions",
          models: [{ id: "m1" }],
        },
      },
    });
    fixture.reply("GET /v1/models", { body: { data: [{ id: "a" }] } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await discover()).toEqual({ models: [{ id: "a" }] });
      expect(stderr.mock.calls.map(([line]) => String(line))).toContain("pap-helper: auth_unavailable\n");
    } finally {
      stderr.mockRestore();
    }
    expect(fixture.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("does not follow a cross-origin 307 and sends the key nowhere else", async () => {
    const other = await startProviderFixture();
    try {
      fixture.reply("GET /v1/models", { status: 307, headers: { location: `${other.baseUrl}/models` } });
      other.reply("GET /v1/models", { body: { data: [{ id: "x" }] } });
      expect(await discover()).toEqual({ models: [], code: "network" });
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });
});

describe("models.test: redirects and classification", () => {
  const withClaude = async (base: string) =>
    bed.write(join(bed.agentDir, "models.json"), {
      providers: {
        mine: {
          name: "Mine",
          baseUrl: fixture.baseUrl,
          apiKey: KEY,
          api: "openai-completions",
          models: [{ id: "m1" }],
        },
        claude: {
          name: "Claude-like",
          baseUrl: base,
          apiKey: KEY,
          api: "anthropic-messages",
          models: [{ id: "c1" }],
        },
      },
    });

  it("does not follow a cross-origin 307 (openai-completions), and the key goes nowhere else", async () => {
    const other = await startProviderFixture();
    try {
      fixture.reply("POST /v1/chat/completions", {
        status: 307,
        headers: { location: `${other.baseUrl}/chat/completions` },
      });
      other.reply("POST /v1/chat/completions", { body: completionStream("x") });
      const result = await test();
      expect(result).toMatchObject({ ok: false, code: "network" });
      expect(fixture.requests.map((r) => r.url)).toEqual(["/v1/chat/completions"]);
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("does not follow a cross-origin 307 (anthropic-messages), where x-api-key would travel", async () => {
    const other = await startProviderFixture();
    try {
      await withClaude(fixture.baseUrl.replace(/\/v1$/, ""));
      fixture.reply("POST /v1/messages", { status: 307, headers: { location: `${other.baseUrl}/messages` } });
      other.reply("POST /v1/messages", { body: {} });
      const result = await test("c1", "claude");
      expect(result).toMatchObject({ ok: false, code: "network" });
      expect(fixture.requests.map((r) => r.url.split("?")[0])).toEqual(["/v1/messages"]);
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("classes from the HTTP status only: a number in the provider's text decides nothing", async () => {
    const error = { error: { message: "upstream 503 and 404 for key", type: "x" } };
    fixture.reply("POST /v1/chat/completions", {
      headers: { "content-type": "text/event-stream" },
      body: `data: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`,
    });
    expect(await test()).toMatchObject({ ok: false, code: "network" });
  });

  it("classifies a status by its class and nothing else", () => {
    expect(failureClass(401)).toBe("http_4xx");
    expect(failureClass(503)).toBe("http_5xx");
    expect(failureClass(200)).toBe("network");
    expect(failureClass(undefined)).toBe("network");
  });
});

describe("models.test", () => {
  it("sends one completion of at most 16 output tokens with the key, and answers ok with a latency", async () => {
    fixture.reply("POST /v1/chat/completions", {
      headers: { "content-type": "text/event-stream" },
      body: completionStream("hi"),
    });
    const result = await test();
    expect(result).toMatchObject({ ok: true });
    expect(Number.isInteger(result.latencyMs) && result.latencyMs >= 0).toBe(true);
    expect(ModelsTestResult.safeParse(result).success).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    const sent = JSON.parse(fixture.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(16);
    expect(fixture.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("reduces a refusal to a status class, with no provider text", async () => {
    fixture.reply("POST /v1/chat/completions", { status: 401, body: { error: { message: `no ${KEY}` } } });
    const denied = await test();
    expect(denied).toMatchObject({ ok: false, code: "http_4xx" });
    fixture.reply("POST /v1/chat/completions", { status: 500, body: { error: { message: `boom ${KEY}` } } });
    const broken = await test();
    expect(broken).toMatchObject({ ok: false, code: "http_5xx" });
    expect(JSON.stringify([denied, broken])).not.toContain(KEY);
    expect(fixture.requests).toHaveLength(2);
  });

  it("answers network when nothing listens", async () => {
    await fixture.close();
    expect(await test()).toMatchObject({ ok: false, code: "network" });
  });

  it("answers timeout when the provider does not answer in time", async () => {
    fixture.reply("POST /v1/chat/completions", { hang: true });
    const op = createTestOp({ timeoutMs: 60 });
    expect(await op.run({ provider: "mine", modelId: "m1" }, bed.context())).toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("refuses a provider or a model that does not exist before any request", async () => {
    expect(await codeOf(test("m1", "nope"))).toBe("not_found");
    expect(await codeOf(test("nope"))).toBe("not_found");
    expect(fixture.requests).toHaveLength(0);
  });
});
