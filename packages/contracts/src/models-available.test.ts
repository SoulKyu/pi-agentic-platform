import { describe, expect, it } from "vitest";
import { AVAILABLE_MODELS_MAX, AvailableModels, HELPER_OPS, methods, MODELS_LIMITS } from "./index.ts";

const model = { provider: "p", id: "m", name: "M", reasoning: false };
const answer = {
  models: [model],
  providers: [{ id: "p", name: "P" }],
  origin: "signed-in",
  truncated: false,
};

describe("models.available contract", () => {
  it("accepts a plain answer and refuses a field it does not list", () => {
    expect(AvailableModels.safeParse(answer).success).toBe(true);
    expect(AvailableModels.safeParse({ ...answer, warnings: [] }).success).toBe(false);
    expect(AvailableModels.safeParse({ ...answer, models: [{ ...model, key: "sk" }] }).success).toBe(false);
    expect(
      AvailableModels.safeParse({ ...answer, providers: [{ id: "p", name: "P", url: "x" }] }).success,
    ).toBe(false);
  });

  it("refuses more than 2000 models and the session origin", () => {
    const many = (count: number) => Array.from({ length: count }, () => model);
    expect(AvailableModels.safeParse({ ...answer, models: many(AVAILABLE_MODELS_MAX) }).success).toBe(true);
    expect(AvailableModels.safeParse({ ...answer, models: many(AVAILABLE_MODELS_MAX + 1) }).success).toBe(
      false,
    );
    expect(AvailableModels.safeParse({ ...answer, origin: "session" }).success).toBe(false);
    expect(AvailableModels.safeParse({ ...answer, origin: "scope" }).success).toBe(true);
  });

  it("keeps the provider list within the Settings cap", () => {
    expect(AVAILABLE_MODELS_MAX).toBe(MODELS_LIMITS.models);
    const providers = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: "P" }));
    expect(
      AvailableModels.safeParse({ ...answer, providers: providers(MODELS_LIMITS.providers) }).success,
    ).toBe(true);
    expect(
      AvailableModels.safeParse({ ...answer, providers: providers(MODELS_LIMITS.providers + 1) }).success,
    ).toBe(false);
  });

  it("declares models.available as an idempotent pi:read query taking an optional cwd", () => {
    const def = methods["models.available"];
    expect(def).toMatchObject({ permission: "pi:read", idempotent: true });
    expect(def.errors).toEqual([
      "invalid_cwd",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ]);
    expect(def.params.safeParse({}).success).toBe(true);
    expect(def.params.safeParse({ cwd: "/work" }).success).toBe(true);
    expect(def.params.safeParse({ cwd: "" }).success).toBe(false);
    expect(def.params.safeParse({ cwd: "/work", extra: 1 }).success).toBe(false);
    expect(def.result.safeParse(answer).success).toBe(true);
  });

  it("has a helper op that takes no params (the daemon passes cwd in the context)", () => {
    expect(HELPER_OPS["models.available"].params.safeParse({}).success).toBe(true);
    expect(HELPER_OPS["models.available"].params.safeParse({ cwd: "/x" }).success).toBe(false);
    expect(HELPER_OPS["models.available"].result).toBe(AvailableModels);
  });
});
