import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { modelsRpc } from "./rpc.ts";

const ctx = (caller = testCaller()) => ({
  caller,
  connectionId: "c1",
  openSubscription: () => "s",
  closeSubscription: () => {},
});
const OK = { ok: true } as const;
/** The sign-in half of the service, answering nothing: the tests that do not look at it need it only for the type. */
const signIn = {
  login: async () => ({ flowId: "f1" }),
  loginAnswer: async () => OK,
  loginCancel: async () => OK,
  cancelLogin: async () => OK,
  subscribeLogin: async () => ({ sub: "s" }),
  setApiKey: async () => OK,
  logout: async () => OK,
  available: async () => ({}) as never,
  configGet: async () => ({ text: null, issues: [], revision: "0".repeat(64), path: "/a/models.json" }),
  configSave: async () => ({ revision: "0".repeat(64), enabledModelsSynced: true }),
};

/** The provider half of the service (discover, test, pricing, usage), answering nothing. */
const provider = {
  discover: async () => ({ models: [] }),
  test: async () => ({ ok: true, latencyMs: 1 }),
  pricing: async () => ({ entries: [] }),
  usage: async () => ({ status: "unsupported" as const }),
  extensions: async () => ({ providers: [], truncated: false, failed: false }),
};

/** The provider form half (Task 10), answering nothing. */
const providerForm = {
  get: async () => ({ editable: false as const, reason: "not_in_file" as const, revision: "0".repeat(64) }),
  save: async () => ({ revision: "0".repeat(64), enabledModelsSynced: true }),
  remove: async () => ({ revision: "0".repeat(64), enabledModelsSynced: true }),
};

describe("modelsRpc", () => {
  it("hands each method to one service call with the caller from the context", async () => {
    const seen: unknown[] = [];
    const rpc = modelsRpc({
      ...signIn,
      ...provider,
      providerForm,
      overview: async (caller, cwd) => (seen.push(["overview", caller.userId, cwd]), {} as never),
      setDefault: async (caller, params) => (seen.push(["setDefault", caller.userId, params]), { ok: true }),
      setDefaultThinking: async (caller, params) => (
        seen.push(["thinking", caller.userId, params]),
        { ok: true }
      ),
      setEnabled: async (caller, params) => (
        seen.push(["enabled", caller.userId, params]),
        { patterns: null }
      ),
      refreshCatalog: async () => (
        seen.push(["refresh"]),
        { changed: false, offline: false, failedProviders: [] }
      ),
    });
    await rpc["models.overview"]({ cwd: "/w/api" }, ctx());
    await rpc["models.setDefault"]({ provider: "p", modelId: "m" }, ctx());
    await rpc["models.setDefaultThinking"]({ level: "low" }, ctx());
    await rpc["models.setEnabled"]({ op: { op: "clear" }, cwd: "/w/api" }, ctx());
    await rpc["models.refreshCatalog"]({}, ctx());
    expect(seen).toEqual([
      ["overview", "u1", "/w/api"],
      ["setDefault", "u1", { provider: "p", modelId: "m" }],
      ["thinking", "u1", { level: "low" }],
      ["enabled", "u1", { op: { op: "clear" }, cwd: "/w/api" }],
      ["refresh"],
    ]);
  });

  it("lets a typed error through", async () => {
    const rpc = modelsRpc({
      ...signIn,
      ...provider,
      providerForm,
      overview: async () => {
        throw new PapError("invalid_cwd");
      },
      setDefault: async () => ({ ok: true }),
      setDefaultThinking: async () => ({ ok: true }),
      setEnabled: async () => ({ patterns: null }),
      refreshCatalog: async () => ({ changed: false, offline: false, failedProviders: [] }),
    });
    await expect(rpc["models.overview"]({ cwd: "/x" }, ctx())).rejects.toMatchObject({ code: "invalid_cwd" });
  });
});

describe("modelsRpc: sign-in", () => {
  it("hands each method to one service call with the caller, and opens the login stream with the flow id as key", async () => {
    const seen: unknown[] = [];
    const rpc = modelsRpc({
      overview: async () => ({}) as never,
      setDefault: async () => OK,
      available: async () => ({}) as never,
      setDefaultThinking: async () => OK,
      setEnabled: async () => ({ patterns: null }),
      refreshCatalog: async () => ({ changed: false, offline: false, failedProviders: [] }),
      configGet: signIn.configGet,
      configSave: signIn.configSave,
      ...provider,
      providerForm,
      login: async (caller, params) => (seen.push(["login", caller.userId, params]), { flowId: "f1" }),
      loginAnswer: async (caller, params) => (seen.push(["answer", caller.userId, params]), OK),
      loginCancel: async (caller, params) => (seen.push(["cancel", caller.userId, params]), OK),
      cancelLogin: async (caller, params) => (seen.push(["cancelLogin", caller.userId, params]), OK),
      subscribeLogin: async (caller, flowId, open) => (
        seen.push(["subscribe", caller.userId, flowId]),
        { sub: open(flowId) }
      ),
      setApiKey: async (caller, params) => (seen.push(["key", caller.userId, Object.keys(params)]), OK),
      logout: async (caller, params) => (seen.push(["logout", caller.userId, params]), OK),
    });
    expect(await rpc["models.login"]({ provider: "p", method: "oauth" }, ctx())).toEqual({ flowId: "f1" });
    await rpc["models.loginAnswer"]({ flowId: "f1", promptId: "p1", value: "v" }, ctx());
    await rpc["models.loginCancel"]({ flowId: "f1" }, ctx());
    await rpc["models.cancelLogin"]({ provider: "p" }, ctx());
    const opened: unknown[] = [];
    const subscription = await rpc["subscribe.login"](
      { flowId: "f1", after: { epoch: "e", seq: 3 } },
      {
        ...ctx(),
        openSubscription: (stream, key, after) => (opened.push([stream, key, after]), "s7"),
      },
    );
    await rpc["models.setApiKey"]({ provider: "p", key: "k" }, ctx());
    await rpc["models.logout"]({ provider: "p" }, ctx());
    expect(subscription).toEqual({ sub: "s7" });
    expect(opened).toEqual([["login", "f1", { epoch: "e", seq: 3 }]]);
    expect(seen).toEqual([
      ["login", "u1", { provider: "p", method: "oauth" }],
      ["answer", "u1", { flowId: "f1", promptId: "p1", value: "v" }],
      ["cancel", "u1", { flowId: "f1" }],
      ["cancelLogin", "u1", { provider: "p" }],
      ["subscribe", "u1", "f1"],
      ["key", "u1", ["provider", "key"]],
      ["logout", "u1", { provider: "p" }],
    ]);
  });
});

describe("modelsRpc: models.json editor", () => {
  it("hands the save to one service call with the caller and the params, and the read to one call", async () => {
    const seen: unknown[] = [];
    const rpc = modelsRpc({
      ...(signIn as never as Parameters<typeof modelsRpc>[0]),
      configGet: async () => (seen.push(["get"]), signIn.configGet()),
      configSave: async (caller, params) => (seen.push(["save", caller.userId, params]), signIn.configSave()),
    });
    await rpc["models.config.get"]({}, ctx());
    await rpc["models.config.save"]({ text: "{}", baseRevision: "a".repeat(64) }, ctx());
    expect(seen).toEqual([["get"], ["save", "u1", { text: "{}", baseRevision: "a".repeat(64) }]]);
  });
});

describe("modelsRpc: provider discover, test and pricing", () => {
  it("hands each method to one service call with the caller and the params", async () => {
    const seen: unknown[] = [];
    const rpc = modelsRpc({
      ...(signIn as never as Parameters<typeof modelsRpc>[0]),
      discover: async (caller, params) => (seen.push(["discover", caller.userId, params]), { models: [] }),
      test: async (caller, params) => (
        seen.push(["test", caller.userId, params]),
        { ok: true, latencyMs: 2 }
      ),
      pricing: async (caller, params) => (seen.push(["pricing", caller.userId, params]), { entries: [] }),
    });
    await rpc["models.discover"]({ provider: "p" }, ctx());
    await rpc["models.test"]({ provider: "p", modelId: "m" }, ctx());
    await rpc["models.pricing"]({ modelId: "m" }, ctx());
    expect(seen).toEqual([
      ["discover", "u1", { provider: "p" }],
      ["test", "u1", { provider: "p", modelId: "m" }],
      ["pricing", "u1", { modelId: "m" }],
    ]);
  });

  it("lets forbidden through from the pricing lookup", async () => {
    const rpc = modelsRpc({
      ...(signIn as never as Parameters<typeof modelsRpc>[0]),
      pricing: async () => {
        throw new PapError("forbidden");
      },
    });
    await expect(rpc["models.pricing"]({ modelId: "m" }, ctx())).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("modelsRpc: provider form", () => {
  it("hands get, save and remove to one providerForm call each, with the caller and the params as decoded", async () => {
    const seen: unknown[] = [];
    const base = {
      ...signIn,
      ...provider,
      overview: async () => ({}) as never,
      setDefault: async () => OK,
      setDefaultThinking: async () => OK,
      setEnabled: async () => ({ patterns: null }),
      refreshCatalog: async () => ({ changed: false, offline: false, failedProviders: [] }),
    };
    const rpc = modelsRpc({
      ...base,
      providerForm: {
        get: async (caller, params) => (seen.push(["get", caller.userId, params]), providerForm.get()),
        save: async (caller, params) => (seen.push(["save", caller.userId, params.id]), providerForm.save()),
        remove: async (caller, params) => (
          seen.push(["remove", caller.userId, params]),
          providerForm.remove()
        ),
      },
    });
    const remove = { id: "Odd", baseRevision: "a".repeat(64), alsoRemoveKey: true };
    await rpc["models.provider.get"]({ id: "x" }, ctx());
    await rpc["models.provider.remove"](remove, ctx());
    expect(seen).toEqual([
      ["get", "u1", { id: "x" }],
      ["remove", "u1", remove],
    ]);
  });
});
