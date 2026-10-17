import { describe, expect, it } from "vitest";
import {
  EXTENSION_MODELS_MAX,
  EXTENSION_PROVIDERS_MAX,
  ExtensionProviders,
  HELPER_OPS,
  methods,
  MODELS_LIMITS,
} from "./index.ts";

const model = (id: string) => ({ provider: "ext1", id, name: id, reasoning: false });
const provider = (extra: object = {}) => ({
  id: "ext1",
  name: "Ext",
  models: [model("m")],
  modelsTruncated: false,
  ...extra,
});
const answer = { providers: [provider()], truncated: false, failed: false };

describe("ExtensionProviders", () => {
  it("accepts the answer and refuses an extra field at both levels (no baseUrl, header or key can ride along)", () => {
    expect(ExtensionProviders.safeParse(answer).success).toBe(true);
    expect(ExtensionProviders.safeParse({ ...answer, extra: 1 }).success).toBe(false);
    expect(
      ExtensionProviders.safeParse({ ...answer, providers: [provider({ baseUrl: "https://x" })] }).success,
    ).toBe(false);
    expect(ExtensionProviders.safeParse({ ...answer, providers: [provider({ apiKey: "k" })] }).success).toBe(
      false,
    );
  });

  it("holds the caps: 128-character id, 256-character name, 500 models, the providers limit", () => {
    const parse = (value: unknown) => ExtensionProviders.safeParse(value).success;
    expect(parse({ ...answer, providers: [provider({ id: "" })] })).toBe(false);
    expect(parse({ ...answer, providers: [provider({ id: "i".repeat(128) })] })).toBe(true);
    expect(parse({ ...answer, providers: [provider({ id: "i".repeat(129) })] })).toBe(false);
    expect(parse({ ...answer, providers: [provider({ name: "n".repeat(256) })] })).toBe(true);
    expect(parse({ ...answer, providers: [provider({ name: "n".repeat(257) })] })).toBe(false);
    const many = (count: number) => Array.from({ length: count }, (_, i) => model(`m${i}`));
    expect(parse({ ...answer, providers: [provider({ models: many(500) })] })).toBe(true);
    expect(parse({ ...answer, providers: [provider({ models: many(501) })] })).toBe(false);
    const providers = (count: number) => Array.from({ length: count }, (_, i) => provider({ id: `p${i}` }));
    expect(parse({ ...answer, providers: providers(300) })).toBe(true);
    expect(parse({ ...answer, providers: providers(301) })).toBe(false);
  });

  it("refuses an extra field on a model row", () => {
    const row = { ...model("m"), baseUrl: "https://x" };
    expect(
      ExtensionProviders.safeParse({ ...answer, providers: [provider({ models: [row] })] }).success,
    ).toBe(false);
  });

  it("requires failed, truncated and modelsTruncated", () => {
    expect(ExtensionProviders.safeParse({ providers: [], failed: false }).success).toBe(false);
    expect(ExtensionProviders.safeParse({ providers: [], truncated: false }).success).toBe(false);
    expect(ExtensionProviders.safeParse({ providers: [] }).success).toBe(false);
    expect(
      ExtensionProviders.safeParse({
        providers: [provider({ modelsTruncated: undefined })],
        truncated: false,
        failed: false,
      }).success,
    ).toBe(false);
  });

  it("keeps its limits equal to the models limits (models-methods.ts spreads this file in, so it cannot import them)", () => {
    expect(EXTENSION_PROVIDERS_MAX).toBe(MODELS_LIMITS.providers);
    expect(EXTENSION_MODELS_MAX).toBe(500);
  });
});

describe("models.extensions", () => {
  it("is a pi:admin idempotent read with no params and the three read errors", () => {
    const method = methods["models.extensions"];
    expect(method.permission).toBe("pi:admin");
    expect(method.idempotent).toBe(true);
    expect(method.params.safeParse({}).success).toBe(true);
    expect(method.params.safeParse({ cwd: "/x" }).success).toBe(false);
    expect(method.result).toBe(ExtensionProviders);
    expect(method.errors).toEqual([
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ]);
    expect(method.sensitiveParams ?? []).toEqual([]);
  });

  it("is a helper op with no params", () => {
    expect(HELPER_OPS["models.extensions"].result).toBe(ExtensionProviders);
    expect(HELPER_OPS["models.extensions"].params.safeParse({}).success).toBe(true);
    expect(HELPER_OPS["models.extensions"].params.safeParse({ cwd: "/x" }).success).toBe(false);
  });
});
