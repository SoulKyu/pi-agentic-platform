import { connect } from "node:net";
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
  ...extra,
});
const core = (extra: Partial<AgentsVmCore["config"]> = {}): AgentsVmCore => ({
  config: config(extra),
  clock: createFakeClock(),
  logger: silentLogger,
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
const compose = (c: AgentsVmCore, seams: AgentsVmSeams = {}) => composeAgentsVm(c, closers, seams);

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
    closers
      .splice(0)
      .reverse()
      .forEach((c) => void c.close());
    await spawning;
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
