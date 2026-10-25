import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { composePi, type ComposePiDeps } from "./compose-pi.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { testCaller } from "./testing/caller.ts";
import type { Config } from "./kernel/config.ts";
import { silentLogger } from "./kernel/logger.ts";
import { killAllWorkerGroups } from "./kernel/supervisor/process-group.ts";

const state = vi.hoisted(() => ({ children: [] as unknown[], forkArgs: [] as unknown[][] }));
vi.mock("node:child_process", () => ({
  fork: vi.fn((...args: unknown[]) => {
    state.forkArgs.push(args);
    return state.children.shift();
  }),
}));

class FakeChild extends EventEmitter {
  pid = 7001;
  connected = true;
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  sent: Array<{ type: string }> = [];
  send = vi.fn((record: { type: string }, callback?: (error: Error | null) => void) => {
    this.sent.push(record);
    callback?.(null);
    return true;
  });
}

const config = (overrides: Partial<Config> = {}) =>
  ({
    home: "/pap-home",
    piAgentDir: "/pi/agent",
    piHostEntry: "/repo/packages/pi-host/dist/main.js",
    piHostExecArgv: ["--conditions=development"],
    testProviderScript: null,
    helpersMax: 2,
    ...overrides,
  }) as Config;

const deps = (
  overrides: Partial<Config> = {},
  env: NodeJS.ProcessEnv = { PATH: "/bin", PAP_HOME: "/leak" },
) =>
  ({
    config: config(overrides),
    env,
    clock: createFakeClock(),
    logger: silentLogger,
    projects: { port: { covers: () => false } },
    audit: { port: { append: () => {} } },
    settings: { port: { models: () => ({ modelsDevPricing: false }) } },
    hub: { publish: () => {}, registerSnapshot: () => {}, onLastSubscriberLeft: () => {} },
  }) as unknown as ComposePiDeps;

let kill: MockInstance<typeof process.kill>;
beforeEach(() => {
  state.children.length = 0;
  state.forkArgs.length = 0;
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => {
  killAllWorkerGroups();
  kill.mockRestore();
});

describe("composePi: boot sweep", () => {
  it("removes the models.json validation copies a killed helper left in the pap home", async () => {
    const home = mkdtempSync(join(tmpdir(), "pap-compose-"));
    try {
      mkdirSync(join(home, "models-check", "check-x"), { recursive: true });
      writeFileSync(join(home, "models-check", "check-x", "models.json"), "{}");
      composePi(deps({ home }));
      await vi.waitFor(() => expect(existsSync(join(home, "models-check"))).toBe(false), { timeout: 2000 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("composePi", () => {
  it("holds the models and mcp methods and returns the helper pool", () => {
    const pi = composePi(deps());
    expect(Object.keys(pi.rpc).sort()).toEqual([
      "agents.packages",
      "mcp.add",
      "mcp.overview",
      "mcp.remove",
      "mcp.setCodemode",
      "mcp.setEnabled",
      "mcp.setExposure",
      "mcp.setInProject",
      "mcp.test",
      "mcp.undo",
      "models.available",
      "models.cancelLogin",
      "models.config.get",
      "models.config.save",
      "models.discover",
      "models.extensions",
      "models.login",
      "models.loginAnswer",
      "models.loginCancel",
      "models.logout",
      "models.overview",
      "models.pricing",
      "models.provider.get",
      "models.provider.remove",
      "models.provider.save",
      "models.refreshCatalog",
      "models.setApiKey",
      "models.setDefault",
      "models.setDefaultThinking",
      "models.setEnabled",
      "models.test",
      "models.usage",
      "plugins.install",
      "plugins.list",
      "plugins.remove",
      "plugins.setEnabled",
      "plugins.update",
      "skills.install",
      "skills.list",
      "skills.search",
      "skills.setInvocation",
      "subscribe.login",
      "trust.set",
      "trust.status",
    ]);
    expect(pi.helpers.active()).toBe(0);
  });

  it("answers models.available through the composed module: one helper run, cached for the second call (MP-RT-06)", async () => {
    const pi = composePi(deps());
    const listing = {
      models: [{ provider: "p", id: "m", name: "M", reasoning: false }],
      providers: [{ id: "p", name: "P" }],
      origin: "signed-in",
      truncated: false,
    };
    const child = new FakeChild();
    state.children.push(child);
    const ctx = { caller: testCaller() } as never;
    const first = pi.rpc["models.available"]({}, ctx);
    expect(child.sent[0]).toMatchObject({ type: "helper_run", op: "models.available" });
    child.emit("message", { type: "helper_done", ok: true, result: listing });
    expect(await first).toEqual(listing);
    child.emit("exit", 0, null);
    child.emit("close");
    expect(await pi.rpc["models.available"]({}, ctx)).toEqual(listing);
    expect(state.forkArgs).toHaveLength(1);
  });

  it("answers models.provider.save through the composed module: step-up first, then one helper run in the shared write queue, then the audit row (M11a I2)", async () => {
    const audit: unknown[] = [];
    const base = deps();
    const clock = createFakeClock();
    const pi = composePi({
      ...base,
      clock,
      audit: { port: { append: (line: unknown) => void audit.push(line) } },
    } as unknown as ComposePiDeps);
    const body = {
      mode: "create",
      id: "mine",
      provider: {
        id: "mine",
        api: "openai-completions",
        baseUrl: "https://example.test/v1",
        auth: { kind: "stored" },
        headers: [],
        models: [],
      },
      baseRevision: "a".repeat(64),
    } as never;
    await expect(
      pi.rpc["models.provider.save"](body, { caller: testCaller() } as never),
    ).rejects.toMatchObject({ code: "step_up_required" });
    expect(state.forkArgs).toHaveLength(0);
    const child = new FakeChild();
    state.children.push(child);
    const stepped = { caller: testCaller({ stepUpUntil: clock.now() + 60_000 }) } as never;
    const saving = pi.rpc["models.provider.save"](body, stepped);
    // The write waits one turn in the queue before its helper starts.
    await vi.waitFor(() => expect(child.sent).toHaveLength(1));
    expect(child.sent[0]).toMatchObject({
      type: "helper_run",
      op: "models.provider.save",
      params: { id: "mine", mode: "create", baseRevision: "a".repeat(64) },
    });
    expect((child.sent[0] as unknown as { params: { revisionKey: string } }).params.revisionKey).toMatch(
      /^[0-9a-f]{64}$/,
    );
    child.emit("message", {
      type: "helper_done",
      ok: true,
      result: { revision: "b".repeat(64), enabledModelsSynced: true },
    });
    expect(await saving).toEqual({ revision: "b".repeat(64), enabledModelsSynced: true });
    expect(audit).toMatchObject([{ reason: "provider_saved", detail: { provider: "mine" } }]);
  });

  it("starts the helper entry that sits beside the worker entry, in the agent directory, capped by the config", () => {
    const pi = composePi(deps());
    const child = new FakeChild();
    state.children.push(child);
    pi.helpers.run("ping", {}, { deadlineMs: 1000 }).done.catch(() => {});
    const [entry, , options] = state.forkArgs[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(entry).toBe("/repo/packages/pi-host/dist/helper/main.js");
    expect(options.env.PI_CODING_AGENT_DIR).toBe("/pi/agent");
    expect(options.env.PAP_HOME).toBeUndefined();
    expect(options.env.PAP_TEST_PROVIDER).toBeUndefined();
    expect(child.sent[0]).toMatchObject({ type: "helper_run", agentDir: "/pi/agent", papHome: "/pap-home" });
    state.children.push(new FakeChild());
    pi.helpers.run("ping", {}, { deadlineMs: 1000 }).done.catch(() => {});
    pi.helpers.run("ping", {}, { deadlineMs: 1000 }).done.catch(() => {});
    expect(pi.helpers.status()).toEqual({ active: 2, max: 2, waiting: 1 });
  });

  it("tells the owners that watch launches the helper counts, once a second, with no ids", async () => {
    const clock = createFakeClock();
    const sent: Array<[string, string, unknown]> = [];
    const base = deps();
    const pi = composePi({
      ...base,
      clock,
      hub: {
        ...base.hub,
        publish: (stream: string, key: string, event: unknown) => void sent.push([stream, key, event]),
      },
    } as unknown as ComposePiDeps);
    pi.bindHelperOwners(() => ["u1", "u2"]);
    state.children.push(new FakeChild());
    pi.helpers.run("ping", {}, { deadlineMs: 1000 }).done.catch(() => {});
    expect(sent).toEqual([
      ["launches", "u1", { kind: "helpers", helpers: { active: 1, max: 2, waiting: 0 } }],
      ["launches", "u2", { kind: "helpers", helpers: { active: 1, max: 2, waiting: 0 } }],
    ]);
  });

  it("follows the worker entry's extension in development, and enables the test ops only with a test script", () => {
    const pi = composePi(
      deps({ piHostEntry: "/repo/packages/pi-host/src/main.ts", testProviderScript: "/script.json" }),
    );
    state.children.push(new FakeChild());
    pi.helpers.run("ping", {}, { deadlineMs: 1000 }).done.catch(() => {});
    const [entry, , options] = state.forkArgs[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(entry).toBe("/repo/packages/pi-host/src/helper/main.ts");
    expect(options.env.PAP_TEST_PROVIDER).toBe("1");
  });

  it("stopAll() stops a running helper and waits for it", async () => {
    const pi = composePi(deps());
    const child = new FakeChild();
    state.children.push(child);
    const handle = pi.helpers.run("ping", {}, { deadlineMs: 60_000 });
    const rejected = handle.done.catch((error: { code: string }) => error.code);
    let stopped = false;
    const stopping = pi.stopAll().then(() => (stopped = true));
    expect(child.sent.map((record) => record.type)).toEqual(["helper_run", "helper_cancel"]);
    await Promise.resolve();
    expect(stopped).toBe(false);
    child.emit("exit", 0, null);
    child.emit("close");
    await stopping;
    expect(await rejected).toBe("helper_failed");
    expect(pi.helpers.active()).toBe(0);
  });
});
