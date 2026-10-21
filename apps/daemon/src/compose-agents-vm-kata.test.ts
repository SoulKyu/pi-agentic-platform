import { EventEmitter } from "node:events";
import { connect, createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_NET, AgentInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentsVm,
  type AgentsVmCore,
  type AgentsVmSeams,
  composeAgentsVm,
} from "./compose-agents-vm.ts";
import { composeKata } from "./compose-agents-vm-kata.ts";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import { createFakeVmd, type FakeVmd } from "./modules/agent-vm/testing/fake-vmd.ts";
import type { AgentRuntimeBackend } from "./modules/agent-vm/index.ts";
import type { SessionRow } from "./modules/sessions/index.ts";

/*
 * Mutants (RT-43), run for real in the T15a report: "loopback relay under Kata" (the relay case), "gateway on loopback under
 * Kata" (the bind case), "process layout under Kata" (the layout case), "script copied under Kata" (the M9 case), "bridge
 * not awaited" (the bridge cases), "link not wired" / "forget not called" (the link case), "strict map dropped" (the picks case).
 */
const created: Array<Record<string, unknown>> = [];
vi.mock("./modules/sessions/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/sessions/index.ts")>();
  return {
    ...original,
    createVmLaunch: (deps: Parameters<typeof original.createVmLaunch>[0]) => (
      created.push(deps as never),
      original.createVmLaunch(deps)
    ),
  };
});

const runtimes: Array<Record<string, unknown>> = [];
vi.mock("./modules/agent-vm/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/agent-vm/index.ts")>();
  return {
    ...original,
    createAgentRuntime: (deps: Parameters<typeof original.createAgentRuntime>[0]) => (
      runtimes.push(deps as never),
      original.createAgentRuntime(deps)
    ),
  };
});

type ToImage = (agentId: string, image: string, sources: string[] | null) => string[] | null;
const ID = "scout-0001";
const child = () =>
  Object.assign(new EventEmitter(), { send: () => true, kill: () => true, sent: [] as unknown[] });
let freePort = 0;
const reserveFreePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
const dial = (host: string, port: number): Promise<"open" | "refused"> =>
  new Promise((resolve) => {
    const socket = connect(port, host);
    socket.once("connect", () => (socket.destroy(), resolve("open")));
    socket.once("error", () => resolve("refused"));
  });
let root: string;
let clock: FakeClock;
let fake: FakeVmd;
const closers: Array<{ name: string; close(): void | Promise<void> }> = [];

const core = (extra: Partial<AgentsVmCore["config"]> = {}): AgentsVmCore => ({
  config: {
    home: join(root, "pap"),
    agentsRuntime: "vm",
    agentsMemoryMaxMb: 8192,
    testAgentRuntime: null,
    testProviderScript: null,
    workerIdleMs: 0,
    minFreeDiskMb: 0,
    piHostEntry: "/x/pi-host/src/main.ts",
    piHostExecArgv: [],
    piAgentDir: join(root, "agent"),
    ...extra,
  },
  clock,
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
const seams = (extra: AgentsVmSeams = {}): AgentsVmSeams => ({
  relay: "off",
  kata: {
    client: fake,
    gatewayBind: { host: "127.0.0.1", port: freePort },
    bundleRoot: join(root, "bundle"),
    nodeImage: `docker.io/library/node@sha256:${"9".repeat(64)}`,
    knownSecrets: () => [],
  },
  ...extra,
});
const kata = (extra: AgentsVmSeams = {}, c: AgentsVmCore = core()) =>
  composeAgentsVm(c, closers, seams(extra)) as Promise<AgentsVm>;
const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({
    id: "0f6c0f2e-1111-4222-8333-444455556666",
    ownerId: "u1",
    agentId: ID,
    agentRole: "thread",
    ...extra,
  }) as SessionRow;

beforeEach(async () => {
  freePort = await reserveFreePort();
  root = mkdtempSync(join(tmpdir(), "pap-t15-compose-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "bundle"), { recursive: true });
  writeFileSync(join(root, "bundle", "package.json"), "{}");
  writeFileSync(join(root, "agent", "settings.json"), "{}");
  clock = createFakeClock();
  fake = createFakeVmd();
  created.length = 0;
  runtimes.length = 0;
});
afterEach(async () => {
  for (const closer of closers.splice(0).reverse()) await closer.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the Kata backend through pap-vmd", () => {
  it("waits for pap0, then stops what pap-vmd lists (the boot, RT-42), then listens", async () => {
    fake.running.add("old-9z9z");
    const vm = await kata();
    expect(fake.ops().slice(0, 3)).toEqual(["vmd.health", "vm.list", "vm.stop"]);
    expect(fake.of("vm.stop")[0]).toEqual({ op: "vm.stop", agentId: "old-9z9z", taskKey: null });
    expect(vm.gatewayPort).toBe(freePort);
  });

  it("gives up, naming pap-vmd, when pap's firewall table is not loaded (M5)", async () => {
    fake.ruleset = false;
    const failing = kata().then(
      () => "up",
      (error: Error) => error.message,
    );
    await clock.advance(2_000 * 31);
    await expect(failing).resolves.toMatch(/pap-vmd/);
    expect(closers).toEqual([]);
  });

  it("names the address and pap-vmd when the gateway cannot bind it (M9a)", async () => {
    const failing = kata({
      kata: { ...seams().kata, gatewayBind: { host: "192.0.2.1", port: 7841 } },
    }).then(
      () => "up",
      (error: Error) => error.message,
    );
    const message = await failing;
    expect(message).toContain("192.0.2.1:7841");
    expect(message).toMatch(/pap-vmd/);
    expect(closers).toEqual([]);
  });

  it("listens on the address its bind names, and by default on the bridge's host address (R34)", async () => {
    const vm = await kata({ kata: { ...seams().kata, gatewayBind: { host: "127.0.0.2", port: 0 } } });
    expect(await dial("127.0.0.2", vm.gatewayPort)).toBe("open");
    expect(await dial("127.0.0.1", vm.gatewayPort)).toBe("refused");
    const parts = composeKata(
      { home: join(root, "pap"), piAgentDir: join(root, "agent"), clock, logger: silentLogger },
      { client: fake },
      () => {},
    );
    expect(parts.gatewayBind).toEqual({ host: AGENT_NET.host, port: AGENT_NET.gatewayPort });
    expect(parts.proxyBind).toEqual({ host: AGENT_NET.host, port: AGENT_NET.proxyPort });
  });

  it("waits while pap0 is being made, and gives up with a message that names pap-vmd", async () => {
    fake.bridge = false;
    const booting = kata().then(
      () => "up",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(fake.of("vmd.health")).toHaveLength(1));
    fake.bridge = true;
    await clock.advance(2_000);
    await expect(booting).resolves.toBe("up");
    for (const closer of closers.splice(0).reverse()) await closer.close();
    fake.bridge = false;
    const failing = kata().then(
      () => "up",
      (error: Error) => error.message,
    );
    await clock.advance(2_000 * 31);
    await expect(failing).resolves.toMatch(/pap-vmd/);
    expect(closers).toEqual([]);
  });

  it("stops the boot when pap-vmd is not there", async () => {
    await expect(
      composeAgentsVm(core(), closers, { relay: "off", kata: { socket: join(root, "none.sock") } }),
    ).rejects.toThrow(/pap-vmd/);
    expect(closers).toEqual([]);
  });

  it("uses the Kata layout of the VM, the same for a thread and a task", async () => {
    const vm = await kata();
    expect(vm.vmLayoutOf(row())?.root).toBe("/agent");
    expect(vm.vmLayoutOf(row({ agentRole: "task" }))?.pi).toBe("/agent/.pi");
  });
});

describe("the relay on Kata (J1a report, AVM-P10)", () => {
  it("listens on the bridge's address and 7842, and starts only after pap0 exists", async () => {
    const listens: string[] = [];
    const order: string[] = [];
    fake.handle(
      "vmd.health",
      () => (order.push("health"), { version: "0", ruleset: true, bridge: true, stateFreeMb: 1 }),
    );
    const vm = await kata({
      relay: {
        fork: (listen) => (listens.push(listen), order.push("fork"), child() as never),
      },
    });
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    expect(listens).toEqual([`${AGENT_NET.host}:${AGENT_NET.relayPort}`]);
    expect(order.indexOf("health")).toBeLessThan(order.indexOf("fork"));
    expect(vm.relay).not.toBeNull();
  });

  it("stays on loopback under a test backend", async () => {
    const listens: string[] = [];
    const backend: AgentRuntimeBackend = {
      start: async () => ({ address: "127.0.0.1" }),
      stop: async () => {},
      list: async () => [],
    };
    await composeAgentsVm(core(), closers, {
      backend: () => backend,
      relay: { fork: (listen) => (listens.push(listen), child() as never) },
    });
    await vi.waitFor(() => expect(listens).toEqual(["127.0.0.1:0"]));
  });
});

describe("the scripted provider under Kata (M9, AVM-E15)", () => {
  it("copies nothing and names no host path: the copier exists for the process backend only", async () => {
    await kata({}, core({ testProviderScript: join(root, "script.json") }));
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty("copyProviderScript");
    expect(existsSync(join(root, "pap", "tmp"))).toBe(false);
  });

  it("is there for the process backend", async () => {
    writeFileSync(join(root, "script.json"), "{}");
    await composeAgentsVm(
      core({ testAgentRuntime: "process", testProviderScript: join(root, "script.json") }),
      closers,
      { relay: "off", process: { guestEntry: "/g.js", execArgv: [], imageAgentSource: "/i" } },
    );
    expect(created[0]).toHaveProperty("copyProviderScript");
  });
});

describe("the images of a launch", () => {
  const input = AgentInput.parse({ name: "Scout", systemPackages: ["git"] });

  it("builds base, profile and agent layers through pap-vmd and answers the agent layer's tag", async () => {
    await kata();
    const imageTagOf = created[0]?.imageTagOf as (
      agentId: string,
      input: AgentInput,
      kind: string,
    ) => Promise<string>;
    const tag = await imageTagOf(ID, input, "thread");
    expect(fake.of("image.build").map((build) => build.layer)).toEqual(["base", "profile", "agent"]);
    expect(tag).toBe(fake.of("image.build")[2]?.tag);
    expect(readdirSync(join(root, "pap", "vm"))).toContain("image-entries.json");
  });

  it("refuses the picks of an agent whose profile image was never built (AVM-E44)", async () => {
    await kata();
    const toImage = created[0]?.toImageEntries as ToImage;
    expect(toImage(ID, "pap-agent-agent-x", null)).toBeNull();
    expect(() => toImage(ID, "pap-agent-agent-x", ["npm:left-pad@1.0.0"])).toThrow(
      expect.objectContaining({ code: "worker_failed" }) as Error,
    );
  });
});

describe("what the agents module is given (T15)", () => {
  it("stops an agent's VMs, trashes a deleted agent's disk and mirrors, purges, and forgets its picks", async () => {
    const vm = await kata();
    const imageTagOf = created[0]?.imageTagOf as (
      agentId: string,
      input: AgentInput,
      kind: string,
    ) => Promise<string>;
    const toImage = created[0]?.toImageEntries as ToImage;
    const tag = await imageTagOf(ID, AgentInput.parse({ name: "Scout" }), "thread");
    expect(toImage(ID, tag, ["npm:a"])).toEqual([]);
    mkdirSync(join(root, "pap", "agents", ".mirrors", ID), { recursive: true });
    writeFileSync(join(root, "pap", "agents", ".mirrors", ID, "s.jsonl"), "x");
    fake.disks.set(ID, 4096);
    await vm.agentLink.stop(ID);
    await vm.agentLink.dispose(ID, 1_760_000_000_000);
    expect(() => toImage(ID, tag, ["npm:a"])).toThrow(
      expect.objectContaining({ code: "worker_failed" }) as Error,
    );
    expect(fake.of("disk.delete")).toEqual([{ op: "disk.delete", agentId: ID, taskKey: null, purge: false }]);
    expect(readdirSync(join(root, "pap", "agents", ".trash"))).toEqual([`${ID}-1760000000000.mirrors`]);
    await vm.agentLink.purge(ID);
    expect(fake.of("trash.purge")).toEqual([{ op: "trash.purge", agentId: ID }]);
    expect(readdirSync(join(root, "pap", "agents", ".trash"))).toEqual([]);
  });

  // I1: the runtime forgets the VM whether or not pap-vmd stopped it; the link asks pap-vmd itself and says when it could not.
  it.each(["unavailable", "failed"] as const)(
    "stop fails, and can be asked again, when pap-vmd answers %s",
    async (code) => {
      const vm = await kata();
      fake.running.add(ID);
      fake.running.add(`${ID}/${"c".repeat(32)}`);
      fake.running.add("other-0002");
      fake.failNext("vm.stop", code);
      await expect(vm.agentLink.stop(ID)).rejects.toBeDefined();
      // The task's VM was still tried; only the one that failed is left (and the other agent's, untouched).
      expect([...fake.running].sort()).toEqual(["other-0002", ID]);
      await vm.agentLink.stop(ID);
      expect([...fake.running]).toEqual(["other-0002"]);
    },
  );

  it("stop fails when the listing fails", async () => {
    const vm = await kata();
    fake.failNext("vm.list", "unavailable");
    await expect(vm.agentLink.stop(ID)).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });

  // M9a: a relay that cannot start says where it should have listened.
  it("logs the relay's address and pap-vmd when the relay cannot start", async () => {
    const { logger, lines } = captureLogger();
    await composeAgentsVm({ ...core(), logger }, closers, {
      ...seams(),
      relay: { fork: () => child() as never },
      bridgeReady: () => Promise.reject(new Error("EADDRNOTAVAIL")),
    });
    await vi.waitFor(() => expect(lines.some((line) => line.msg === "relay_start_failed")).toBe(true));
    const line = lines.find((one) => one.msg === "relay_start_failed");
    expect(line).toMatchObject({ listen: `${AGENT_NET.host}:${AGENT_NET.relayPort}` });
    expect(String(line?.hint)).toMatch(/pap-vmd/);
  });

  it("sweeps the daemon's trash daily and rebuilds the base weekly, and stops both with the daemon", async () => {
    await kata();
    expect(closers.map((closer) => closer.name)).toEqual([
      "agent_vm_proxy",
      "agent_mirrors",
      "agent_vm",
      "agent_trash_sweep",
      "agent_image_upgrades",
    ]);
    // The VM proxy's usage report, the mirrors' sweeper, the trash sweep and the weekly base check: one timer each.
    expect(clock.pending()).toBe(4);
    for (const closer of closers.splice(0).reverse()) await closer.close();
    expect(clock.pending()).toBe(0);
  });

  // RT-40: the runtime's crash pause goes to the registry's handler, bound once the registry exists; Resume reaches the runtime.
  it("hands the runtime's crash pause to the registry once it is bound, and Resume to the runtime", async () => {
    const vm = await kata();
    const runtimeDeps = runtimes[0] as { onCrashPause(agentId: string): void };
    const resume = vi.spyOn(vm.runtime, "resume");
    expect(() => runtimeDeps.onCrashPause(ID)).not.toThrow();
    const paused: string[] = [];
    vm.bindCrashPause((agentId) => void paused.push(agentId));
    runtimeDeps.onCrashPause(ID);
    expect(paused).toEqual([ID]);
    vm.agentLink.resume(ID);
    expect(resume).toHaveBeenCalledWith(ID);
  });
});
