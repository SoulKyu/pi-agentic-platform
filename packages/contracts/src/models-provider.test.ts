import { describe, expect, it } from "vitest";
import { HELPER_OPS, methods, pickPrices } from "./index.ts";

describe("models.discover", () => {
  it("is pi:admin, a mutation-class call with the password step-up", () => {
    expect(methods["models.discover"]).toMatchObject({ permission: "pi:admin", idempotent: false });
    expect(methods["models.discover"].errors).toContain("step_up_required");
  });

  it("answers the three copied fields, a status class on failure, and nothing else", () => {
    const { result } = methods["models.discover"];
    expect(
      result.safeParse({ models: [{ id: "m", contextWindow: 8192, maxTokens: 512, reasoning: true }] })
        .success,
    ).toBe(true);
    expect(result.safeParse({ models: [], code: "http_4xx" }).success).toBe(true);
    expect(result.safeParse({ models: [], truncated: true }).success).toBe(true);
    expect(result.safeParse({ models: [], truncated: "yes" }).success).toBe(false);
    for (const bad of [
      { models: [{ id: "m", name: "M" }] },
      { models: [{ id: "m", contextWindow: 0 }] },
      { models: [{ id: "" }] },
      { models: [], code: "http_404" },
      { models: [], body: "sk-1" },
      { models: Array.from({ length: 2001 }, (_, i) => ({ id: `m${i}` })) },
    ])
      expect(result.safeParse(bad).success).toBe(false);
  });
});

describe("models.test", () => {
  it("is pi:admin and answers ok, a latency and a status class", () => {
    expect(methods["models.test"]).toMatchObject({ permission: "pi:admin", idempotent: false });
    const { result } = methods["models.test"];
    expect(result.safeParse({ ok: true, latencyMs: 12 }).success).toBe(true);
    expect(result.safeParse({ ok: false, latencyMs: 3, code: "timeout" }).success).toBe(true);
    expect(result.safeParse({ ok: false, latencyMs: 3, code: "some provider text" }).success).toBe(false);
    expect(result.safeParse({ ok: false, latencyMs: 3, message: "401 sk-1" }).success).toBe(false);
  });
});

describe("models.pricing", () => {
  it("is pi:read, forbidden while the switch is off, and bounded to ten numeric entries", () => {
    expect(methods["models.pricing"]).toMatchObject({ permission: "pi:read", idempotent: true });
    expect(methods["models.pricing"].errors).toContain("forbidden");
    const { result, params } = methods["models.pricing"];
    expect(params.safeParse({ modelId: "gpt-5" }).success).toBe(true);
    expect(params.safeParse({ provider: "openai", modelId: "gpt-5", url: "http://x" }).success).toBe(false);
    const entry = {
      provider: "openai",
      id: "gpt-5",
      input: 1.25,
      output: 10,
      cacheRead: 0.1,
      contextWindow: 4e5,
    };
    expect(result.safeParse({ entries: [entry] }).success).toBe(true);
    expect(result.safeParse({ entries: [{ ...entry, input: "1" }] }).success).toBe(false);
    expect(result.safeParse({ entries: [{ ...entry, name: "GPT" }] }).success).toBe(false);
    expect(result.safeParse({ entries: Array.from({ length: 11 }, () => entry) }).success).toBe(false);
  });
});

describe("pickPrices", () => {
  const catalog = [
    { provider: "a", id: "m", input: 1 },
    { provider: "b", id: "m", input: 2 },
    { provider: "a", id: "n", input: 3 },
  ];
  it("answers the entries for a model, narrowed to a provider when given, at most ten", () => {
    expect(pickPrices(catalog, undefined, "m")).toEqual([catalog[0], catalog[1]]);
    expect(pickPrices(catalog, "b", "m")).toEqual([catalog[1]]);
    expect(pickPrices(catalog, undefined, "zzz")).toEqual([]);
    expect(
      pickPrices(
        Array.from({ length: 15 }, (_, i) => ({ provider: `p${i}`, id: "m" })),
        undefined,
        "m",
      ),
    ).toHaveLength(10);
  });
});

describe("helper operations", () => {
  it("parses the daemon's params and the helper's result strictly", () => {
    expect(HELPER_OPS["models.discover"].params.safeParse({ provider: "p" }).success).toBe(true);
    expect(HELPER_OPS["models.test"].params.safeParse({ provider: "p", modelId: "m" }).success).toBe(true);
    expect(HELPER_OPS["models.pricing"].params.safeParse({ modelId: "m" }).success).toBe(true);
    expect(HELPER_OPS["models.test"].result.safeParse({ ok: true, latencyMs: 1, key: "sk-1" }).success).toBe(
      false,
    );
  });
});
