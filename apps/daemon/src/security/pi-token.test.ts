import {
  type Caller,
  type HandlerContext,
  type HandlerTable,
  methods,
  type MethodDef,
  TOKEN_PERMISSIONS,
  TokenPermission,
} from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../kernel/ws/dispatcher.ts";
import { silentLogger } from "../kernel/logger.ts";
import { testCaller } from "../testing/caller.ts";

const catalogue = Object.values(methods) as MethodDef[];
const piAdmin = catalogue.filter((def) => def.permission === "pi:admin");

/**
 * Valid params for every `pi:admin` method (`confirmProtected: true` where it takes one). A task that adds such a
 * method adds its sample here; the test below fails until it does, so no method escapes the token check (M7R152).
 */
const SAMPLES: Record<string, unknown> = {
  "models.setDefault": { provider: "p", modelId: "m" },
  "models.setDefaultThinking": { level: "high" },
  "models.setEnabled": { op: { op: "clear" } },
  "models.refreshCatalog": {},
  "models.config.get": {},
  "mcp.overview": {},
  "mcp.setEnabled": { servers: [{ scope: "global", name: "a" }], enabled: false },
  "mcp.setExposure": { scope: "global", name: "a", exposure: "direct" },
  "mcp.setInProject": { name: "a", enabled: false, cwd: "/w" },
  "mcp.remove": { scope: "global", name: "a" },
  "mcp.undo": { token: "t" },
  "mcp.add": { scope: "global", name: "a", entry: { command: "x" } },
  "mcp.setCodemode": { choice: "always" },
  "mcp.test": { scope: "global", name: "a" },
  "trust.status": { cwd: "/w" },
  "trust.set": { cwd: "/w", decision: true },
  "skills.list": {},
  "skills.setInvocation": { items: [{ path: "/a/SKILL.md", disabled: true }] },
  "skills.search": { query: "web" },
  "skills.install": { source: "o/r", scope: "global" },
  "plugins.list": {},
  "plugins.install": { source: "npm:x", scope: "user" },
  "plugins.remove": { source: "npm:x", scope: "user" },
  "plugins.update": {},
  "plugins.setEnabled": { items: [{ source: "npm:x", scope: "user" }], enabled: false },
  "models.config.save": { text: "{}", baseRevision: "0".repeat(64) },
  "models.provider.get": {},
  "models.provider.save": {
    mode: "create",
    id: "x",
    provider: {
      id: "x",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      auth: { kind: "stored" },
      headers: [],
      models: [],
    },
    baseRevision: "0".repeat(64),
  },
  "models.provider.remove": { id: "x", baseRevision: "0".repeat(64), alsoRemoveKey: false },
  "models.discover": { provider: "anthropic" },
  "models.test": { provider: "anthropic", modelId: "m" },
  "models.usage": { providerId: "openrouter" },
  "models.extensions": {},
  "models.login": { provider: "anthropic", method: "oauth" },
  "models.loginAnswer": { flowId: "f1", promptId: "p1", value: "x" },
  "models.loginCancel": { flowId: "f1" },
  "models.cancelLogin": { provider: "anthropic" },
  "subscribe.login": { flowId: "f1" },
  "models.setApiKey": { provider: "anthropic", key: "sk-1" },
  "models.logout": { provider: "anthropic" },
  "agents.vm.setClaudeToken": { token: "t" },
  "agents.vm.clearClaudeToken": {},
};

const tokenCaller = (): Caller =>
  testCaller({ kind: "token", credentialId: "tok1", permissions: new Set(TOKEN_PERMISSIONS) });

function bed() {
  const ran = vi.fn(async () => ({}));
  // Every method of the catalogue is wired to the same recorder: a handler that runs would show in `ran`.
  const handlers = Object.fromEntries(catalogue.map((def) => [def.name, ran])) as unknown as HandlerTable;
  const receipts = { find: () => null, save: () => {}, purge: () => 0, readOnly: false };
  const dispatch = createDispatcher({ handlers, receipts, logger: silentLogger });
  const ctx = (caller: Caller): HandlerContext => ({
    caller,
    connectionId: "c1",
    openSubscription: () => "s1",
    closeSubscription: () => {},
  });
  return {
    ran,
    call: (method: string, params: unknown, caller: Caller) =>
      dispatch({ id: 1, method, params, commandId: "cmd-0001" }, ctx(caller)),
  };
}

describe("a token never makes a code-running Pi change (M7R152)", () => {
  it("cannot be minted with pi:admin, and holds no pi:admin permission", () => {
    expect(TokenPermission.safeParse("pi:admin").success).toBe(false);
    expect(TOKEN_PERMISSIONS).not.toContain("pi:admin");
  });

  it("lists at least 35 pi:admin methods, so the loop below cannot pass over an empty catalogue (M7R152)", () => {
    expect(piAdmin.length).toBeGreaterThanOrEqual(35);
  });

  it("has a sample for every pi:admin method of the catalogue", () => {
    expect(piAdmin.map((def) => def.name).filter((name) => !(name in SAMPLES))).toEqual([]);
  });

  it.each(piAdmin.map((def) => [def.name]))(
    "answers a token forbidden on %s and runs no handler",
    async (name) => {
      const { ran, call } = bed();
      const response = await call(name as string, SAMPLES[name as string], tokenCaller());
      expect(response).toEqual({ id: 1, ok: false, error: { code: "forbidden" } });
      expect(ran).not.toHaveBeenCalled();
    },
  );

  it("answers a token holding pi:read forbidden on models.config.get, and still lets an owner session read (MC33)", async () => {
    expect(TOKEN_PERMISSIONS).toContain("pi:read");
    const { ran, call } = bed();
    const refused = await call("models.config.get", {}, tokenCaller());
    expect(refused).toEqual({ id: 1, ok: false, error: { code: "forbidden" } });
    expect(ran).not.toHaveBeenCalled();
    const allowed = await call("models.config.get", {}, testCaller());
    expect(allowed).not.toMatchObject({ error: { code: "forbidden" } });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("answers a token holding pi:read forbidden on mcp.overview, and still lets an owner session read (MC38)", async () => {
    const { ran, call } = bed();
    const refused = await call("mcp.overview", {}, tokenCaller());
    expect(refused).toEqual({ id: 1, ok: false, error: { code: "forbidden" } });
    expect(ran).not.toHaveBeenCalled();
    const allowed = await call("mcp.overview", {}, testCaller());
    expect(allowed).not.toMatchObject({ error: { code: "forbidden" } });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("is exercised by a dispatcher that really refuses a token a method it lacks the permission for", async () => {
    const { ran, call } = bed();
    const control = catalogue.find((def) => def.permission === "policy:admin");
    expect(control).toBeDefined();
    const refused = await call(control?.name ?? "", {}, tokenCaller());
    expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(ran).not.toHaveBeenCalled();
    // The same dispatcher does not refuse a caller that holds the permission, so the refusal above is the permission's.
    const allowed = await call(control?.name ?? "", {}, testCaller());
    expect(allowed).not.toMatchObject({ error: { code: "forbidden" } });
  });
});
