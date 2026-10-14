import { describe, expect, it } from "vitest";
import { methods, MODELS_LIMITS, ModelsOverview, ProviderView } from "./index.ts";

const model = { provider: "p", id: "m", name: "M", reasoning: false, enabled: true };
const provider = {
  id: "p",
  name: "P",
  origin: "builtin",
  auth: { oauthLabel: null, apiKey: true, configured: false, stored: null, status: "known", env: [] },
  models: [model],
  modelsTruncated: false,
};
const overview = {
  providers: [provider],
  defaults: { provider: null, model: null, thinkingLevel: null },
  enabled: { patterns: null, scope: "global", settingsPath: "/a/settings.json", warnings: [] },
  offline: false,
  truncated: false,
};

describe("models methods", () => {
  it("bounds the environment variable names a provider shows (MC26) and refuses a value in their place", () => {
    const withEnv = (env: unknown) =>
      ProviderView.safeParse({ ...provider, auth: { ...provider.auth, env } });
    expect(withEnv([{ name: "OPENAI_API_KEY", set: true }]).success).toBe(true);
    expect(withEnv(Array.from({ length: 9 }, () => ({ name: "A", set: false }))).success).toBe(false);
    expect(withEnv([{ name: "A".repeat(65), set: false }]).success).toBe(false);
    expect(withEnv([{ name: "A", set: true, value: "sk-x" }]).success).toBe(false);
    expect(ProviderView.safeParse({ ...provider, auth: { ...provider.auth, env: undefined } }).success).toBe(
      false,
    );
  });

  it("declares the overview as a pi:read query and the three writes as pi:admin mutations", () => {
    expect(methods["models.overview"]).toMatchObject({ permission: "pi:read", idempotent: true });
    for (const name of ["models.setDefault", "models.setDefaultThinking", "models.refreshCatalog"] as const)
      expect(methods[name]).toMatchObject({ permission: "pi:admin", idempotent: false });
  });

  it("lists the error codes a caller can meet", () => {
    expect(methods["models.overview"].errors).toEqual([
      "invalid_cwd",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ]);
    expect(methods["models.setDefault"].errors).toEqual([
      "bad_request",
      "not_found",
      "invalid_cwd",
      "project_scope",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ]);
    expect(methods["models.setDefaultThinking"].errors).toContain("project_scope");
    expect(methods["models.refreshCatalog"].errors).toEqual(["capacity", "timeout", "helper_failed"]);
  });

  it("bounds the params", () => {
    const { params } = methods["models.setDefault"];
    const ok = { provider: "p", modelId: "m" };
    expect(params.safeParse(ok).success).toBe(true);
    expect(params.safeParse({ ...ok, cwd: "/work" }).success).toBe(true);
    for (const bad of [
      { provider: "" },
      { provider: "p".repeat(129) },
      { modelId: "" },
      { modelId: "m".repeat(257) },
      { cwd: "" },
      { cwd: "x".repeat(4097) },
    ])
      expect(params.safeParse({ ...ok, ...bad }).success).toBe(false);
    expect(methods["models.setDefaultThinking"].params.safeParse({ level: "high" }).success).toBe(true);
    expect(methods["models.setDefaultThinking"].params.safeParse({ level: "huge" }).success).toBe(false);
    expect(methods["models.overview"].params.safeParse({}).success).toBe(true);
    expect(methods["models.refreshCatalog"].params.safeParse({}).success).toBe(true);
    expect(
      methods["models.refreshCatalog"].result.safeParse({
        changed: true,
        offline: false,
        failedProviders: ["q"],
      }).success,
    ).toBe(true);
    expect(methods["models.refreshCatalog"].result.safeParse({ changed: true, offline: false }).success).toBe(
      false,
    );
    expect(
      methods["models.refreshCatalog"].result.safeParse({
        changed: true,
        offline: false,
        failedProviders: Array.from({ length: 301 }, () => "p"),
      }).success,
    ).toBe(false);
  });
});

describe("ModelsOverview", () => {
  it("accepts a full overview", () => {
    expect(ModelsOverview.safeParse(overview).success).toBe(true);
    expect(
      ModelsOverview.safeParse({
        ...overview,
        defaults: { provider: "p", model: "m", thinkingLevel: "high" },
        enabled: {
          patterns: ["p/*"],
          scope: "project",
          settingsPath: "/w/.pi/settings.json",
          warnings: ["w"],
        },
      }).success,
    ).toBe(true);
  });

  it("refuses an extra field on the overview, a provider, its auth and a model", () => {
    expect(ModelsOverview.safeParse({ ...overview, extra: 1 }).success).toBe(false);
    expect(ProviderView.safeParse({ ...provider, apiKey: "sk-secret" }).success).toBe(false);
    expect(
      ProviderView.safeParse({ ...provider, auth: { ...provider.auth, key: "sk-secret" } }).success,
    ).toBe(false);
    expect(ProviderView.safeParse({ ...provider, models: [{ ...model, secret: 1 }] }).success).toBe(false);
    expect(ModelsOverview.safeParse({ ...overview, enabled: { ...overview.enabled, x: 1 } }).success).toBe(
      false,
    );
    expect(ModelsOverview.safeParse({ ...overview, defaults: { ...overview.defaults, x: 1 } }).success).toBe(
      false,
    );
  });

  it("accepts the unknown status and refuses any other", () => {
    expect(
      ProviderView.safeParse({ ...provider, auth: { ...provider.auth, status: "unknown" } }).success,
    ).toBe(true);
    expect(ProviderView.safeParse({ ...provider, auth: { ...provider.auth, status: "maybe" } }).success).toBe(
      false,
    );
    expect(
      ProviderView.safeParse({ ...provider, auth: { ...provider.auth, status: undefined } }).success,
    ).toBe(false);
  });

  it("refuses an unknown origin, scope and stored kind", () => {
    expect(ProviderView.safeParse({ ...provider, origin: "extension" }).success).toBe(false);
    expect(
      ModelsOverview.safeParse({ ...overview, enabled: { ...overview.enabled, scope: "x" } }).success,
    ).toBe(false);
    expect(
      ProviderView.safeParse({ ...provider, auth: { ...provider.auth, stored: "password" } }).success,
    ).toBe(false);
  });

  it("stops at the documented counts", () => {
    expect(MODELS_LIMITS).toEqual({ providers: 300, models: 2000, warnings: 50 });
    const many = (n: number) => Array.from({ length: n }, () => provider);
    expect(ModelsOverview.safeParse({ ...overview, providers: many(300) }).success).toBe(true);
    expect(ModelsOverview.safeParse({ ...overview, providers: many(301) }).success).toBe(false);
    const models = (n: number) => Array.from({ length: n }, () => model);
    expect(ProviderView.safeParse({ ...provider, models: models(2000) }).success).toBe(true);
    expect(ProviderView.safeParse({ ...provider, models: models(2001) }).success).toBe(false);
    const warnings = (n: number) => Array.from({ length: n }, () => "w");
    const withWarnings = (n: number) => ({
      ...overview,
      enabled: { ...overview.enabled, warnings: warnings(n) },
    });
    expect(ModelsOverview.safeParse(withWarnings(50)).success).toBe(true);
    expect(ModelsOverview.safeParse(withWarnings(51)).success).toBe(false);
  });
});
