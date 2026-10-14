import { HELPER_OPS, ModelsPricingResult } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { HelperOpError, type HelperContext } from "../ops.ts";
import {
  createPricingOp,
  PRICING_CATALOG_MAX_BYTES,
  PRICING_MAX_BYTES,
  PRICING_URL,
} from "./models-pricing.ts";

const ctx = {
  agentDir: "/a",
  papHome: "/p",
  home: "/h",
  signal: new AbortController().signal,
  emit: () => {},
  prompt: async () => null,
} satisfies HelperContext;

const catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: "free", reasoning: 3 },
        limit: { context: 400000, output: 128000 },
      },
      "gpt-5-mini": { id: "gpt-5-mini", cost: { input: 0.25, output: 2 } },
    },
  },
  azure: {
    id: "azure",
    models: { "gpt-5": { id: "gpt-5", cost: { input: -1, output: Number.NaN }, limit: { context: 4e5 } } },
  },
  junk: "not a provider",
};

const jsonResponse = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
const run = (fetchImpl: typeof fetch, params: { provider?: string; modelId: string }) =>
  createPricingOp(fetchImpl).run(params, ctx);
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof HelperOpError ? error.code : "other"),
  );

describe("models.pricing helper operation", () => {
  it("asks models.dev once, without credentials or redirects, and keeps only numeric cost and context fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalog));
    const result = await run(fetchImpl as never, { modelId: "gpt-5" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PRICING_URL);
    expect(PRICING_URL).toBe("https://models.dev/api.json");
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(init.headers).toBeUndefined();
    const gpt5 = {
      provider: "openai",
      id: "gpt-5",
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      contextWindow: 400000,
    };
    const azure = { provider: "azure", id: "gpt-5", contextWindow: 400000 };
    const mini = { provider: "openai", id: "gpt-5-mini", input: 0.25, output: 2 };
    expect(result).toEqual({ entries: [gpt5, azure], catalog: [gpt5, mini, azure] });
    expect(HELPER_OPS["models.pricing"].result.safeParse(result).success).toBe(true);
    expect(ModelsPricingResult.safeParse({ entries: result.entries }).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("GPT-5");
  });

  it("narrows to one provider when asked, and answers no entries for an unknown model", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalog));
    expect((await run(fetchImpl as never, { provider: "openai", modelId: "gpt-5" })).entries).toHaveLength(1);
    expect((await run(fetchImpl as never, { modelId: "nothing" })).entries).toEqual([]);
  });

  it("answers at most ten entries", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`p${i}`, { models: { m: { id: "m", cost: { input: i } } } }]),
    );
    const result = await run((async () => jsonResponse(many)) as never, { modelId: "m" });
    expect(result.entries).toHaveLength(10);
    expect(result.catalog).toHaveLength(15);
  });

  it("sends no catalog when the extracted map is over the byte budget, but still answers the question", async () => {
    expect(PRICING_CATALOG_MAX_BYTES).toBe(900_000);
    const models = Object.fromEntries(
      Array.from({ length: 6000 }, (_, i) => [
        `${"m".repeat(100)}${i}`,
        { cost: { input: 1.5, output: 2.5 } },
      ]),
    );
    const big = { openai: { models: { ...models, target: { cost: { input: 3 } } } } };
    const result = await run((async () => jsonResponse(big)) as never, { modelId: "target" });
    expect(result).toEqual({ entries: [{ provider: "openai", id: "target", input: 3 }] });
  });

  it("refuses a body over 8 MiB and stops reading it", async () => {
    expect(PRICING_MAX_BYTES).toBe(8 * 1024 * 1024);
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = async () => new Response(body, { status: 200 });
    expect(await codeOf(run(fetchImpl as never, { modelId: "gpt-5" }))).toBe("failed");
    expect(pulled).toBeLessThanOrEqual(10);
  });

  it("refuses at once a body whose declared length is over the cap", async () => {
    const fetchImpl = async () =>
      new Response("{}", { status: 200, headers: { "content-length": String(PRICING_MAX_BYTES + 1) } });
    expect(await codeOf(run(fetchImpl as never, { modelId: "gpt-5" }))).toBe("failed");
  });

  it("fails on an HTTP error, a body that is not JSON, a failed request, and a timeout", async () => {
    expect(
      await codeOf(run((async () => new Response("x", { status: 500 })) as never, { modelId: "m" })),
    ).toBe("failed");
    expect(await codeOf(run((async () => new Response("<html>")) as never, { modelId: "m" }))).toBe("failed");
    expect(
      await codeOf(
        run(
          (async () => {
            throw new TypeError("fetch failed sk-SECRET");
          }) as never,
          { modelId: "m" },
        ),
      ),
    ).toBe("failed");
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as never;
    expect(await codeOf(createPricingOp(hangs, { timeoutMs: 30 }).run({ modelId: "m" }, ctx))).toBe("failed");
  });

  it("does not put the failure's own text in the error", async () => {
    const error: unknown = await createPricingOp((async () => {
      throw new TypeError("fetch failed sk-SECRET-TEXT");
    }) as never)
      .run({ modelId: "m" }, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperOpError);
    expect((error as HelperOpError).message).not.toContain("sk-SECRET-TEXT");
  });
});
