import { HELPER_OPS, PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { modelsBed } from "./testing/bed.ts";

const overview = {
  providers: [
    {
      id: "p",
      name: "P",
      origin: "builtin",
      auth: { oauthLabel: null, apiKey: true, configured: false, stored: null, status: "known", env: [] },
      models: [{ provider: "p", id: "m", name: "M", reasoning: false, enabled: true }],
      modelsTruncated: false,
    },
  ],
  defaults: { provider: null, model: null, thinkingLevel: null },
  enabled: { patterns: null, scope: "global", settingsPath: "/a/settings.json", warnings: [] },
  offline: false,
  truncated: false,
};
const caller = testCaller();
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof PapError ? error.code : "other"),
  );

describe("models service: overview", () => {
  it("asks the helper for the overview and returns what the contract accepts", async () => {
    const { service, calls } = modelsBed(() => overview);
    expect(await service.overview(caller)).toEqual(overview);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "models.overview", params: {} });
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[0]?.options.deadlineMs).toBeGreaterThan(0);
  });

  it("passes a cwd the caller has a project in, and refuses any other with invalid_cwd before a helper starts", async () => {
    const { service, calls } = modelsBed(() => overview);
    await service.overview(caller, "/w/api/src");
    expect(calls[0]?.options.cwd).toBe("/w/api/src");
    expect(await codeOf(service.overview(caller, "/etc"))).toBe("invalid_cwd");
    expect(await codeOf(service.overview(testCaller({ userId: "u2" }), "/w/api"))).toBe("invalid_cwd");
    expect(calls).toHaveLength(1);
  });

  it("refuses a helper result with an extra provider field as helper_failed, and logs no content", async () => {
    const poisoned = {
      ...overview,
      providers: [{ ...overview.providers[0], apiKey: "sk-SECRET-VALUE" }],
    };
    const { service, lines } = modelsBed(() => poisoned);
    expect(await codeOf(service.overview(caller))).toBe("helper_failed");
    expect(JSON.stringify(lines)).not.toContain("sk-SECRET-VALUE");
    expect(lines.some((line) => line.msg === "models_helper_result_invalid")).toBe(true);
  });

  it("refuses a result that is not an overview at all", async () => {
    for (const bad of [null, "text", [], { providers: "x" }]) {
      const { service } = modelsBed(() => bad);
      expect(await codeOf(service.overview(caller))).toBe("helper_failed");
    }
  });

  it("passes the helper's typed failures through", async () => {
    for (const code of [
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
    ] as const) {
      const { service } = modelsBed(() => new PapError(code));
      expect(await codeOf(service.overview(caller))).toBe(code);
    }
  });
});

describe("models service: writes", () => {
  it("setDefault runs the op with the model, checks the cwd, and answers ok", async () => {
    const { service, calls } = modelsBed(() => ({ ok: true }));
    expect(await service.setDefault(caller, { provider: "p", modelId: "m" })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ op: "models.setDefault", params: { provider: "p", modelId: "m" } });
    await service.setDefault(caller, { provider: "p", modelId: "m", cwd: "/w/api" });
    expect(calls[1]?.options.cwd).toBe("/w/api");
    expect(calls[1]?.params).toEqual({ provider: "p", modelId: "m" });
    expect(await codeOf(service.setDefault(caller, { provider: "p", modelId: "m", cwd: "/etc" }))).toBe(
      "invalid_cwd",
    );
    expect(calls).toHaveLength(2);
  });

  it("setDefaultThinking runs its op and passes project_scope on", async () => {
    const { service, calls } = modelsBed(() => ({ ok: true }));
    expect(await service.setDefaultThinking(caller, { level: "high" })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ op: "models.setDefaultThinking", params: { level: "high" } });
    const refused = modelsBed(() => new PapError("project_scope"));
    expect(await codeOf(refused.service.setDefaultThinking(caller, { level: "low", cwd: "/w/api" }))).toBe(
      "project_scope",
    );
    const badRequest = modelsBed(() => new PapError("bad_request"));
    expect(await codeOf(badRequest.service.setDefault(caller, { provider: "p", modelId: "m" }))).toBe(
      "bad_request",
    );
  });

  it("setEnabled runs the op with the edit, checks the cwd, and answers the patterns", async () => {
    const { service, calls } = modelsBed(() => ({ patterns: ["p/*"] }));
    const op = { op: "toggle", provider: "p", modelId: "m", enabled: false } as const;
    expect(await service.setEnabled(caller, { op })).toEqual({ patterns: ["p/*"] });
    expect(calls[0]).toMatchObject({ op: "models.setEnabled", params: { op } });
    expect(calls[0]?.options.cwd).toBeUndefined();
    await service.setEnabled(caller, { op: { op: "clear" }, cwd: "/w/api" });
    expect(calls[1]?.options.cwd).toBe("/w/api");
    expect(calls[1]?.params).toEqual({ op: { op: "clear" } });
    expect(await codeOf(service.setEnabled(caller, { op: { op: "clear" }, cwd: "/etc" }))).toBe(
      "invalid_cwd",
    );
    expect(calls).toHaveLength(2);
  });

  it("setEnabled passes conflict and project_scope on, and accepts a cleared key", async () => {
    for (const code of ["conflict", "project_scope", "not_found"] as const) {
      const { service } = modelsBed(() => new PapError(code));
      expect(await codeOf(service.setEnabled(caller, { op: { op: "prune" } }))).toBe(code);
    }
    const { service } = modelsBed(() => ({ patterns: null }));
    expect(await service.setEnabled(caller, { op: { op: "clear" } })).toEqual({ patterns: null });
  });

  it("setEnabled refuses a result with more than the patterns", async () => {
    const { service } = modelsBed(() => ({ patterns: [], key: "sk-1" }));
    expect(await codeOf(service.setEnabled(caller, { op: { op: "clear" } }))).toBe("helper_failed");
  });

  it("refreshCatalog runs with a long deadline and parses its result", async () => {
    const { service, calls } = modelsBed(() => ({ changed: true, offline: false, failedProviders: [] }));
    expect(await service.refreshCatalog()).toEqual({ changed: true, offline: false, failedProviders: [] });
    expect(calls[0]).toMatchObject({ op: "models.refreshCatalog", params: {} });
    const overviewDeadline = await (async () => {
      await service.overview(caller).catch(() => undefined);
      return calls.at(-1)?.options.deadlineMs ?? 0;
    })();
    expect(calls[0]?.options.deadlineMs).toBeGreaterThan(overviewDeadline);
    const bad = modelsBed(() => ({ changed: "yes" }));
    expect(await codeOf(bad.service.refreshCatalog())).toBe("helper_failed");
  });

  it("refuses a write result with more than ok", async () => {
    const { service } = modelsBed(() => ({ ok: true, key: "sk-1" }));
    expect(await codeOf(service.setDefault(caller, { provider: "p", modelId: "m" }))).toBe("helper_failed");
  });
});

describe("the helper op table", () => {
  it("has the same op names the service runs", async () => {
    const { service, calls, clock } = modelsBed(
      (call) =>
        call.op === "models.overview"
          ? overview
          : call.op === "models.refreshCatalog"
            ? { changed: false, offline: true, failedProviders: [] }
            : call.op === "models.setEnabled"
              ? { patterns: null }
              : call.op === "models.config.get"
                ? { text: null, issues: [], revision: "0".repeat(64), path: "/a/models.json" }
                : call.op === "models.config.save"
                  ? { revision: "0".repeat(64), enabledModelsSynced: true }
                  : call.op === "models.discover"
                    ? { models: [] }
                    : call.op === "models.test"
                      ? { ok: true, latencyMs: 1 }
                      : call.op === "models.pricing"
                        ? { entries: [] }
                        : call.op === "models.usage"
                          ? { status: "query_failed" }
                          : { ok: true },
      undefined,
      { models: () => ({ modelsDevPricing: true }) },
    );
    await service.overview(caller);
    await service.setDefault(caller, { provider: "p", modelId: "m" });
    await service.setDefaultThinking(caller, { level: "low" });
    await service.setEnabled(caller, { op: { op: "clear" } });
    await service.refreshCatalog();
    await service.configGet();
    await service.configSave(testCaller({ stepUpUntil: clock.now() + 1 }), {
      text: "{}",
      baseRevision: "0".repeat(64),
    });
    await service.setApiKey(testCaller({ stepUpUntil: clock.now() + 1 }), { provider: "p", key: "k" });
    await service.logout(caller, { provider: "p" });
    await service.login(testCaller({ stepUpUntil: clock.now() + 1 }), { provider: "p", method: "oauth" });
    await service.discover(testCaller({ stepUpUntil: clock.now() + 1 }), { provider: "p" });
    await service.test(caller, { provider: "p", modelId: "m" });
    await service.pricing(caller, { modelId: "m" });
    await service.usage(caller, { providerId: "openrouter" });
    // The MCP overview, the trust decisions, the skills, the plugins and the subagent profiles belong to their own modules' services.
    const modelsOps = Object.keys(HELPER_OPS).filter(
      (op) =>
        !op.startsWith("mcp.") &&
        !op.startsWith("trust.") &&
        !op.startsWith("skills.") &&
        !op.startsWith("plugins.") &&
        !op.startsWith("subagents."),
    );
    expect(calls.map((call) => call.op).sort()).toEqual(modelsOps.sort());
  });
});
