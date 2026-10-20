import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_VM_PROTOCOL, DEFAULT_AGENT_RESOURCES, encodeSocketFrame } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeAgentsVm,
  type AgentsVm,
  type AgentsVmCore,
  type AgentsVmSeams,
} from "./compose-agents-vm.ts";
import { vmPortsOf } from "./compose-m11-vm.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import type { AgentRuntimeBackend } from "./modules/agent-vm/index.ts";
import type { SessionRow } from "./modules/sessions/index.ts";

const ID = "atlas-1a2b";
const IMAGE = `pap-agent-agent-${"0".repeat(64)}`;
const config = (extra: Partial<AgentsVmCore["config"]> = {}): AgentsVmCore["config"] => ({
  home: "/pap-home",
  agentsRuntime: "vm",
  agentsMemoryMaxMb: 8192,
  testAgentRuntime: "process",
  testProviderScript: "/script.json",
  workerIdleMs: 0,
  minFreeDiskMb: 0,
  piHostEntry: "/x/pi-host/src/main.ts",
  piHostExecArgv: [],
  piAgentDir: "/pi-agent",
  ...extra,
});
const core = (extra: Partial<AgentsVmCore["config"]> = {}): AgentsVmCore => ({
  config: config(extra),
  clock: createFakeClock(),
  logger: silentLogger,
  env: {},
  readOnly: false,
  claudeToken: {
    status: () => "missing",
    set: () => {},
    clear: () => {},
    load: () => null,
    onChange: () => {},
  },
});
const PROCESS = { guestEntry: "/guest.js", execArgv: [], imageAgentSource: "/image" };
const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({
    id: "0f6c0f2e-1111-4222-8333-444455556666",
    ownerId: "u1",
    agentId: ID,
    agentRole: "thread",
    ...extra,
  }) as SessionRow;

const closers: Array<{ name: string; close(): void | Promise<void> }> = [];
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
});
const compose = (c: AgentsVmCore, seams: AgentsVmSeams = {}) =>
  composeAgentsVm(c, closers, { relay: "off", ...seams });

describe("composeAgentsVm in host mode", () => {
  it("composes nothing: no gateway, no closer", async () => {
    expect(await compose(core({ agentsRuntime: "host" }))).toBeNull();
    expect(closers).toEqual([]);
  });
});

describe("composeAgentsVm in vm mode refuses to boot without a backend", () => {
  it("Kata arrives with T15: without the test switch the boot stops", async () => {
    await expect(compose(core({ testAgentRuntime: null }), { process: PROCESS })).rejects.toThrow(/Kata/);
    expect(closers).toEqual([]);
  });
  it("the process backend needs its guest seam and the scripted provider", async () => {
    await expect(compose(core())).rejects.toThrow(/guest/);
    await expect(compose(core({ testProviderScript: null }), { process: PROCESS })).rejects.toThrow(/script/);
    expect(closers).toEqual([]);
  });
});

describe("composeAgentsVm in vm mode", () => {
  const seams = (backend: AgentRuntimeBackend): AgentsVmSeams => ({ backend: () => backend });
  const idle = (): AgentRuntimeBackend => ({
    start: vi.fn(async () => ({ address: "127.0.0.1" })),
    stop: vi.fn(async () => {}),
    list: vi.fn(async () => [{ agentId: "old-9z9z", taskKey: null }]),
  });
  const dial = (port: number): Promise<"open" | "refused"> =>
    new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => (socket.destroy(), resolve("open")));
      socket.once("error", () => resolve("refused"));
    });

  it("listens before it returns, and stops the VMs the backend lists at boot (RT-35, RT-42)", async () => {
    const backend = idle();
    const vm = (await compose(core(), seams(backend))) as AgentsVm;
    expect(vm.gatewayPort).toBeGreaterThan(0);
    expect(await dial(vm.gatewayPort)).toBe("open");
    expect(backend.list).toHaveBeenCalledTimes(1);
    expect(backend.stop).toHaveBeenCalledWith("old-9z9z", null);
  });
  it("closes the gateway and stops the VMs again when the daemon stops", async () => {
    const backend = idle();
    const vm = (await compose(core(), seams(backend))) as AgentsVm;
    for (const closer of closers.splice(0).reverse()) await closer.close();
    expect(await dial(vm.gatewayPort)).toBe("refused");
    expect(backend.list).toHaveBeenCalledTimes(2);
  });
  it("starts no gateway when the boot's stop of the VMs fails: the daemon boot fails closed", async () => {
    const backend = idle();
    backend.stop = vi.fn(async () => {
      throw new Error("vmd down");
    });
    await expect(compose(core(), seams(backend))).rejects.toThrow("vmd down");
    expect(closers).toEqual([]);
  });
  it("answers the layouts of agent rows only: the process backend's folders, a task's own key", async () => {
    const vm = (await compose(core(), seams(idle()))) as AgentsVm;
    expect(vm.vmLayoutOf(row({ agentId: undefined }))).toBeNull();
    expect(vm.vmLayoutOf(row())?.root).toBe(join("/pap-home", "tmp", "agent-vm", ID));
    expect(vm.vmLayoutOf(row({ agentRole: "child" }))?.root).toBe(join("/pap-home", "tmp", "agent-vm", ID));
    const key = "0f6c0f2e111142228333444455556666";
    expect(vm.vmLayoutOf(row({ agentRole: "task" }))?.root).toBe(
      join("/pap-home", "tmp", "agent-vm", `${ID}-${key}`),
    );
    expect(vm.agentRunsInVm("u1", ID)).toBe(true);
    expect(vm.resourceHost().memoryCapMb).toBe(8192);
    expect(vm.resourceHost().cores).toBeGreaterThanOrEqual(1);
  });
  // AVM-P8. Mutant: the gateway's imageOf bound to `() => null` (every hello refused `image`): the VM never reaches running.
  it("binds the gateway's imageOf to the runtime's: a guest naming the launch's image is accepted", async () => {
    let port = 0;
    const backend: AgentRuntimeBackend = {
      ...idle(),
      list: vi.fn(async () => []),
      start: vi.fn(async (spec, launch) => {
        const socket = connect(port, "127.0.0.1");
        socket.write(
          encodeSocketFrame({
            type: "hello",
            role: "guest",
            agentId: spec.agentId,
            launchId: launch.launchId,
            token: launch.token,
            protocol: AGENT_VM_PROTOCOL,
            imageTag: spec.image,
          }),
        );
        closers.push({ name: "guest", close: () => void socket.destroy() });
        return { address: "127.0.0.1" };
      }),
    };
    const vm = (await compose(core(), { backend: () => backend })) as AgentsVm;
    port = vm.gatewayPort;
    const spawning = vm.runtime
      .spawn(
        { agentId: ID, kind: "thread", taskKey: null, image: IMAGE, resources: DEFAULT_AGENT_RESOURCES },
        { sessionFile: null, sessionsDir: "/x", mirrorFor: () => "refused", sent: () => {} },
        null,
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(vm.runtime.phase(ID)).toBe("running"));
    await Promise.all(closers.splice(0).map((closer) => closer.close()));
    await spawning;
  });
});

describe("composeAgentsVm's relay (J1, T12's daemon half)", () => {
  const idle = (): AgentRuntimeBackend => ({
    start: vi.fn(async () => ({ address: "127.0.0.1" })),
    stop: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  });
  const fakeChild = () =>
    Object.assign(new EventEmitter(), {
      sent: [] as unknown[],
      killed: false,
      send(message: unknown) {
        this.sent.push(message);
        return true;
      },
      kill() {
        this.killed = true;
        return true;
      },
    });
  // Mutants: the link not created (or `relay` left null) -> "starts the relay child"; the closer missing -> "stops it".
  it("starts the relay child at compose, hands the Claude token to it, and stops it with the daemon", async () => {
    const child = fakeChild();
    let stored: string | null = "sk-ant-oat01-STORED";
    const listeners: Array<(token: string | null) => void> = [];
    const claudeToken = {
      status: () => "set" as const,
      set: () => {},
      clear: () => {},
      load: () => stored,
      onChange: (listener: (token: string | null) => void) => void listeners.push(listener),
    };
    const vm = (await composeAgentsVm({ ...core(), claudeToken }, closers, {
      backend: () => idle(),
      relay: { fork: () => child as never },
    })) as AgentsVm;
    await vi.waitFor(() => expect(vm.relay).not.toBeNull());
    child.emit("message", { type: "relay_ready", port: 1234 });
    // A relay that starts (or restarts) is told the stored token.
    expect(child.sent).toContainEqual({ type: "claude_token", token: "sk-ant-oat01-STORED" });
    stored = null;
    listeners[0]?.(null);
    expect(child.sent.at(-1)).toEqual({ type: "claude_token", token: null });
    expect(closers.map((closer) => closer.name)).toContain("agent_relay");
    for (const closer of closers.splice(0).reverse()) await closer.close();
    expect(child.killed).toBe(true);
  });

  // I4 through the composition: the relay's requests are compared with the turns the daemon heard in the same window.
  // Mutants: `reportedTurns` bound to 0 -> "a long run logs nothing"; `windowEnded` not bound -> "counts start again".
  it("compares the relay's requests with the turns of the window, and starts each window from zero (I4)", async () => {
    const child = fakeChild();
    const { logger, lines } = captureLogger();
    const live: Array<(sessionId: string) => void> = [];
    const vm = (await composeAgentsVm({ ...core(), logger }, closers, {
      backend: () => idle(),
      relay: { fork: () => child as never },
    })) as AgentsVm;
    vm.bindLate({
      sessions: { mirror: { notice: () => {}, taint: () => {} }, kindOf: () => ({ agentId: ID }) },
      pi: {
        models: {
          available: async () => ({ models: [], providers: [], origin: "signed-in", truncated: false }),
          onChanged: () => {},
        },
      },
      agents: { ownerOf: () => "u1", get: () => null, onChange: () => () => {} },
      runs: {
        port: {
          onLiveCost: (listener: unknown) => (live.push(listener as never), () => {}),
          onRunEnd: () => () => {},
        },
      },
      automation: { agentTasks: { overBudget: () => false } },
    } as never);
    child.emit("message", { type: "relay_ready", port: 1 });
    const usage = (requests: number) =>
      child.emit("message", {
        type: "relay_usage",
        agents: [{ agentId: ID, requests, refused: 0, bytesIn: 1, bytesOut: 1 }],
      });
    for (let i = 0; i < 40; i++) live[0]?.("s1");
    usage(40);
    expect(lines.filter((line) => line.msg === "agent_relay_mismatch")).toEqual([]);
    // The next window has no turns: the same agent's 40 requests are now unexplained.
    usage(40);
    expect(lines.filter((line) => line.msg === "agent_relay_mismatch")).toHaveLength(1);
  });

  it("composes no relay when the seam says off", async () => {
    const vm = (await compose(core(), { backend: () => idle() })) as AgentsVm;
    expect(vm.relay).toBeNull();
    expect(closers.map((closer) => closer.name)).not.toContain("agent_relay");
  });

  it("hands the composition to a test that asks (expose)", async () => {
    const seen: AgentsVm[] = [];
    const vm = (await compose(core(), {
      backend: () => idle(),
      expose: (composed) => void seen.push(composed),
    })) as AgentsVm;
    expect(seen).toEqual([vm]);
  });
});

describe("composeAgentsVm's mirrors (T9b)", () => {
  const FILE = "2026-10-19T10-00-00-000Z_0f6c0f2e.jsonl";
  const idle = (): AgentRuntimeBackend => ({
    start: vi.fn(async () => ({ address: "127.0.0.1" })),
    stop: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  });
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const header = line({ type: "session", version: 3, id: "hdr00001" });
  const chunk = (offset: number, text: string, replace = false) => ({
    type: "session_append" as const,
    file: FILE,
    offset,
    data: Buffer.from(text).toString("base64"),
    replace,
  });
  let home = "";
  afterEach(() => home && rmSync(home, { recursive: true, force: true }));

  it("composes the real mirrors: a worker's file opens under .mirrors/<agent>/ and takes appends", async () => {
    home = mkdtempSync(join(tmpdir(), "pap-compose-"));
    mkdirSync(join(home, "agents", ".mirrors", ID), { recursive: true, mode: 0o700 });
    const vm = (await compose(core({ home }), { backend: () => idle() })) as AgentsVm;
    vm.bindMirrorHooks({ notice: () => {}, taint: () => {}, canWrite: () => true });
    const port = vm.mirrors.inputFor(row({ piPath: null })).mirrorFor(FILE);
    if (port === "refused") throw new Error("the mirror refused");
    expect(port.path).toBe(join(home, "agents", ".mirrors", ID, FILE));
    expect(port.onSessionAppend(chunk(0, header))).toBe("ok");
    expect(readdirSync(join(home, "agents", ".mirrors", ID))).toEqual([FILE, `${FILE}.ids`]);
  });

  it("hands a replacement to the hooks that are bound later: the notice and the taint", async () => {
    home = mkdtempSync(join(tmpdir(), "pap-compose-"));
    mkdirSync(join(home, "agents", ".mirrors", ID), { recursive: true, mode: 0o700 });
    const vm = (await compose(core({ home }), { backend: () => idle() })) as AgentsVm;
    const seen: string[] = [];
    vm.bindMirrorHooks({
      notice: (id, text) => void seen.push(`notice:${id}:${text.slice(0, 10)}`),
      taint: (id) => void seen.push(`taint:${id}`),
      canWrite: () => true,
    });
    const port = vm.mirrors.inputFor(row({ piPath: null })).mirrorFor(FILE);
    if (port === "refused") throw new Error("the mirror refused");
    port.onSessionAppend(chunk(0, header + line({ type: "message", id: "e1" })));
    port.onSessionAppend(chunk(0, header + line({ type: "message", id: "x1" }), true));
    expect(seen).toEqual([
      "notice:0f6c0f2e-1111-4222-8333-444455556666:La VM a ré",
      "taint:0f6c0f2e-1111-4222-8333-444455556666",
    ]);
  });

  // Mutant M-UNBOUND: inputFor works before the hooks are bound: killed here (AVM-E21).
  it("refuses to make a session's mirror input until the hooks are bound", async () => {
    home = mkdtempSync(join(tmpdir(), "pap-compose-"));
    const vm = (await compose(core({ home }), { backend: () => idle() })) as AgentsVm;
    expect(() => vm.mirrors.inputFor(row({ piPath: null }))).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    vm.bindMirrorHooks({ notice: () => {}, taint: () => {}, canWrite: () => true });
    expect(() => vm.mirrors.inputFor(row({ piPath: null }))).not.toThrow();
  });

  it("stops the sweeper of the kept copies when the daemon stops", async () => {
    home = mkdtempSync(join(tmpdir(), "pap-compose-"));
    const clock = createFakeClock();
    const vm = (await compose({ ...core({ home }), clock }, { backend: () => idle() })) as AgentsVm;
    expect(vm.mirrors).toBeDefined();
    expect(clock.pending()).toBeGreaterThan(0);
    for (const closer of closers.splice(0).reverse()) await closer.close();
    expect(clock.pending()).toBe(0);
  });

  it("keeps a mirrors seam that a test supplies", async () => {
    const mirrors = { inputFor: vi.fn(), close: vi.fn() };
    const vm = (await compose(core(), { backend: () => idle(), mirrors: mirrors as never })) as AgentsVm;
    expect(vm.mirrors).toBe(mirrors);
  });
});

describe("vmPortsOf (the M11 wiring is not optional in vm mode)", () => {
  const vm = {
    vmLayoutOf: () => null,
    agentRunsInVm: () => true,
    resourceHost: () => ({ memoryCapMb: 1, cores: 1 }),
  } as unknown as AgentsVm;
  it("host mode adds nothing", () => {
    expect(vmPortsOf(undefined)).toEqual({ sessions: {}, agents: {}, safety: {} });
  });
  it("vm mode hands the predicates to the sessions, the safety services and the resource ceilings", () => {
    const ports = vmPortsOf(vm);
    expect(ports.sessions).toEqual({ vmLayoutOf: vm.vmLayoutOf, agentRunsInVm: vm.agentRunsInVm });
    expect(ports.safety).toEqual({ agentRunsInVm: vm.agentRunsInVm });
    expect(ports.agents).toEqual({ resourceHost: vm.resourceHost });
  });
  it("stops the boot when a predicate is unwired", () => {
    for (const missing of ["vmLayoutOf", "agentRunsInVm", "resourceHost"])
      expect(() => vmPortsOf({ ...vm, [missing]: undefined } as unknown as AgentsVm)).toThrow(
        new RegExp(missing),
      );
  });
});
