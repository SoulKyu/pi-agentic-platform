import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_NET, PapError, VmStatusView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeAgentsVm, type AgentsVmCore } from "./compose-agents-vm.ts";
import { composeAgentsVmRpc } from "./compose-agents-vm-rpc.ts";
import { composeVmStatus, guardedLaunch } from "./compose-agents-vm-status.ts";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { VERSION } from "./kernel/version.ts";
import { createFakeVmd, type FakeVmd } from "./modules/agent-vm/testing/fake-vmd.ts";
import type { SessionRow, VmLaunch } from "./modules/sessions/index.ts";
import { testCaller } from "./testing/caller.ts";

/*
 * Mutants (RT-43), each run for real in the T18 report:
 *  - M-guard: `guardedLaunch` calls the launch without asking the status -> "refuses before anything is built" fails.
 *  - M-order: the guard runs after the launch -> the same case sees a `vm.start`/`image.build` request.
 *  - M-host-bound: `bindStatus` ignored -> "answers the bound view" fails (the host view stays).
 *  - M-owner: the handler passes a fixed owner -> "asks for the caller's agents" fails.
 *  - M-agents: `bindAgents` dropped -> "lists the owner's agents" fails.
 */
const TOKEN = "sk-ant-oat01-OWNER-SETUP-TOKEN-0123456789";
let root: string;
let clock: FakeClock;
let fake: FakeVmd;
const closers: Array<{ name: string; close(): void | Promise<void> }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-t18-compose-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "bundle"), { recursive: true });
  writeFileSync(join(root, "bundle", "package.json"), "{}");
  writeFileSync(join(root, "agent", "settings.json"), "{}");
  clock = createFakeClock();
  fake = createFakeVmd();
  fake.handle("vmd.health", () => ({ version: VERSION, ruleset: true, bridge: true, stateFreeMb: 50_000 }));
});
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
  rmSync(root, { recursive: true, force: true });
});

const claudeToken = (state: "set" | "missing" = "missing") => ({
  status: () => state,
  set: () => {},
  clear: () => {},
  load: () => null,
  onChange: () => {},
});
const core = (): AgentsVmCore => ({
  config: {
    home: join(root, "pap"),
    agentsRuntime: "vm",
    agentsMemoryMaxMb: 8192,
    testAgentRuntime: null,
    testProviderScript: null,
    workerIdleMs: 0,
    minFreeDiskMb: 1000,
    piHostEntry: "/x/pi-host/src/main.ts",
    piHostExecArgv: [],
    piAgentDir: join(root, "agent"),
  },
  clock,
  logger: silentLogger,
  env: {},
  readOnly: false,
  claudeToken: claudeToken(),
});
const vmMode = () =>
  composeAgentsVm(core(), closers, {
    relay: "off",
    kata: {
      client: fake,
      gatewayBind: { host: "127.0.0.1", port: 0 },
      bundleRoot: join(root, "bundle"),
      nodeImage: `docker.io/library/node@sha256:${"9".repeat(64)}`,
      knownSecrets: () => [],
    },
  }) as Promise<NonNullable<Awaited<ReturnType<typeof composeAgentsVm>>>>;
const agentRow = {
  id: "0f6c0f2e-1111-4222-8333-444455556666",
  ownerId: "u1",
  agentId: "scout-0001",
  agentRole: "thread",
} as SessionRow;

describe("vm mode (the Kata composition)", () => {
  it("answers the status from pap-vmd: usable, its version, the host's ceilings", async () => {
    const vm = await vmMode();
    const view = await vm.status.view("u1");
    expect(VmStatusView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ runtime: "vm", usable: true, reason: null, vmdVersion: VERSION });
    expect(view.host).toMatchObject({ memoryMb: 8192 - 512, diskMb: 49_000 });
    expect(view.host?.cpus).toBeGreaterThanOrEqual(1);
  });

  it("refuses a launch `sandbox_unavailable` before anything is built when pap-vmd runs another version (M-guard, M-order)", async () => {
    const vm = await vmMode();
    fake.handle("vmd.health", () => ({ version: "0.0.1", ruleset: true, bridge: true, stateFreeMb: 1 }));
    await clock.advance(10_000);
    const before = fake.ops().length;
    const refused = await vm.launch
      .spawn(agentRow, { vm: true, input: {} } as never, {} as never)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PapError);
    expect((refused as PapError).code).toBe("sandbox_unavailable");
    expect(fake.ops().slice(before)).toEqual(["vmd.health"]);
  });
});

/*
 * S1 item 11 mutants, each run for real: M-no-relay-gate (`guardedLaunch` ignores `relayReady`): "refuses until the relay reported
 * ready" fails; M-any-port (a ready relay on another port counts): the wrong-port case fails; M-gate-after-status (the relay is
 * checked after pap-vmd's health): the "asks pap-vmd nothing" assertion fails.
 */
describe("the relay gates the launches on Kata (S1)", () => {
  const relayChild = () => Object.assign(new EventEmitter(), { send: () => true, kill: () => true });
  const spawnOnce = (vm: Awaited<ReturnType<typeof vmMode>>) =>
    vm.launch.spawn(agentRow, { vm: true, input: {} } as never, {} as never).catch((error: unknown) => error);

  it("refuses until the relay reported ready on its own port, asking pap-vmd nothing meanwhile", async () => {
    const children: Array<ReturnType<typeof relayChild>> = [];
    const vm = await composeAgentsVm(core(), closers, {
      relay: { fork: () => (children.push(relayChild()), children.at(-1) as never) },
      kata: {
        client: fake,
        gatewayBind: { host: "127.0.0.1", port: 0 },
        bundleRoot: join(root, "bundle"),
        nodeImage: `docker.io/library/node@sha256:${"9".repeat(64)}`,
        knownSecrets: () => [],
      },
    });
    if (vm === null) throw new Error("no vm composition");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const before = fake.ops().length;
    // The child exits at once: it could not bind (the port is held by another process). It never becomes ready.
    children[0]?.emit("exit");
    expect(((await spawnOnce(vm)) as PapError).code).toBe("sandbox_unavailable");
    expect(fake.ops().slice(before)).toEqual([]);
    // A relay that listens elsewhere than the bridge's port is not the one the VMs are told about.
    await clock.advance(1_000);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]?.emit("message", { type: "relay_ready", port: AGENT_NET.relayPort + 1 });
    expect(((await spawnOnce(vm)) as PapError).code).toBe("sandbox_unavailable");
    // Ready on 7842: the launch goes on past the gate (and stops later, at the empty init of this test).
    children[1]?.emit("message", { type: "relay_ready", port: AGENT_NET.relayPort });
    expect(((await spawnOnce(vm)) as { code?: string }).code).not.toBe("sandbox_unavailable");
  });
});

describe("guardedLaunch", () => {
  it("refuses sandbox_unavailable without calling the launch while the relay is not ready", async () => {
    const spawn = vi.fn(async () => ({ handle: "h" }));
    let ready = false;
    const launch = guardedLaunch({ spawn } as unknown as VmLaunch, { require: async () => {} }, () => ready);
    await expect(launch.spawn(agentRow, {} as never, {} as never)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    expect(spawn).not.toHaveBeenCalled();
    ready = true;
    await launch.spawn(agentRow, {} as never, {} as never);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("passes the arguments and the result of a launch the status lets through", async () => {
    const started = { handle: "h" };
    const spawn = vi.fn(async () => started);
    const launch = guardedLaunch({ spawn } as unknown as VmLaunch, { require: async () => {} });
    const launched = { vm: true } as never;
    const init = { init: 1 } as never;
    await expect(launch.spawn(agentRow, launched, init)).resolves.toBe(started);
    expect(spawn).toHaveBeenCalledWith(agentRow, launched, init);
  });

  it("does not call the launch when the status refuses (M-guard)", async () => {
    const spawn = vi.fn();
    const launch = guardedLaunch({ spawn } as unknown as VmLaunch, {
      require: async () => {
        throw new PapError("sandbox_unavailable");
      },
    });
    await expect(launch.spawn(agentRow, {} as never, {} as never)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("composeVmStatus", () => {
  const config = { agentsMemoryMaxMb: 4096, minFreeDiskMb: 0 };
  const make = (client: typeof fake | null) =>
    composeVmStatus({ clock, logger: silentLogger, claudeToken: claudeToken(), config }, client, {
      phase: (id) => (id === "a-0001" ? "running" : "stopped"),
    });

  it("lists the owner's agents with their phases once the agents are bound (M-agents)", async () => {
    const { status, bindAgents } = make(fake);
    expect((await status.view("u1")).agents).toEqual([]);
    const list = vi.fn((ownerId: string) => (ownerId === "u1" ? [{ id: "a-0001" }, { id: "b-0002" }] : []));
    bindAgents({ list } as never);
    expect((await status.view("u1")).agents).toEqual([
      { id: "a-0001", phase: "running", migrated: false },
      { id: "b-0002", phase: "stopped", migrated: false },
    ]);
    expect((await status.view("u2")).agents).toEqual([]);
  });

  it("the process backend has no pap-vmd: usable, no version, no ceilings", async () => {
    const view = await make(null).status.view("u1");
    expect(view).toMatchObject({ runtime: "vm", usable: true, reason: null, vmdVersion: null, host: null });
    await expect(make(null).status.require()).resolves.toBeUndefined();
  });
});

describe("agents.vmStatus in both modes (AVM-P17)", () => {
  const rpc = () => {
    const appended: unknown[] = [];
    const composed = composeAgentsVmRpc({ home: join(root, "pap") }, silentLogger, clock, {
      append: (entry: unknown) => void appended.push(entry),
    } as never);
    return composed;
  };
  const ctxOf = (userId = "u1") => ({ caller: testCaller({ userId }) }) as never;

  it("host mode answers T1's view of an unavailable stack", async () => {
    const { rpc: handlers } = rpc();
    expect(await handlers["agents.vmStatus"]({}, ctxOf())).toEqual({
      runtime: "host",
      usable: false,
      reason: "not_configured",
      vmdVersion: null,
      claudeToken: "missing",
      agents: [],
    });
  });

  it("reports the Claude token `set` after a set, `missing` after a clear, and never the value (J1a M10)", async () => {
    const { rpc: handlers, claudeToken: store } = rpc();
    store.set(TOKEN);
    const view = await handlers["agents.vmStatus"]({}, ctxOf());
    expect(view.claudeToken).toBe("set");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    store.clear();
    expect((await handlers["agents.vmStatus"]({}, ctxOf())).claudeToken).toBe("missing");
  });

  it("answers the bound view, for the caller's own agents (M-host-bound, M-owner)", async () => {
    const { rpc: handlers, bindStatus } = rpc();
    const view = vi.fn(async (ownerId: string) => ({
      runtime: "vm" as const,
      usable: true,
      reason: null,
      vmdVersion: "1",
      claudeToken: "missing" as const,
      agents: [{ id: `of-${ownerId}`, phase: "stopped" as const, migrated: false }],
    }));
    bindStatus(view);
    expect((await handlers["agents.vmStatus"]({}, ctxOf("u7"))).agents[0]?.id).toBe("of-u7");
    expect(view).toHaveBeenCalledWith("u7");
    bindStatus(undefined);
    expect((await handlers["agents.vmStatus"]({}, ctxOf())).runtime).toBe("host");
  });
});
