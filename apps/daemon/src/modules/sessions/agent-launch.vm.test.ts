import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, type InitRecord, type VmLayout } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { layoutOf, type VmSpec } from "../agent-vm/index.ts";
import type { SessionsAgentDeps } from "./agent-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort, initRecordOf } from "./testing/fake-policy.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { createVmLaunch } from "./vm-launch.ts";

const ID = "atlas-1a2b";
const IMAGE = `pap-agent-agent-${"c".repeat(64)}`;
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

interface World {
  specs: VmSpec[];
  /** How often the host's probe, vault and one-use values were read. */
  reads: { probe: number; vault: number; once: number };
  /** Holds every runtime.spawn until `release()`. */
  hold: boolean;
  release(): void;
  profile: { sandboxRequired: boolean; quarantined: boolean };
}
const world: World = {
  specs: [],
  reads: { probe: 0, vault: 0, once: 0 },
  hold: false,
  release: () => {},
  profile: { sandboxRequired: true, quarantined: false },
};
const taskKeyOf = (row: { agentRole?: string | undefined; id: string }): string | null =>
  row.agentRole === "task" ? row.id.replaceAll("-", "") : null;

function setup(options: BedOptions = {}, vm = true): { papHome: string } {
  world.specs = [];
  world.reads = { probe: 0, vault: 0, once: 0 };
  world.hold = false;
  world.release = () => {};
  world.profile = { sandboxRequired: true, quarantined: false };
  bed = build({
    ...options,
    ...(vm
      ? {
          vmLaunch: (makeWorker, { papHome }) =>
            createVmLaunch({
              runtime: {
                async spawn(spec: VmSpec) {
                  world.specs.push(spec);
                  if (world.hold) await new Promise<void>((resolve) => (world.release = resolve));
                  return {
                    handle: Object.assign(makeWorker(), { slot: "b".repeat(32), piFile: () => null }),
                    layout: layoutOf("process", papHome, spec),
                    relayKey: "a".repeat(64),
                    slot: "b".repeat(32),
                  };
                },
              } as never,
              papHome,
              layoutOf: (row) =>
                row.agentId === undefined
                  ? null
                  : layoutOf("process", papHome, { agentId: row.agentId, taskKey: taskKeyOf(row) }),
              imageTagOf: () => IMAGE,
              mirrors: {
                inputFor: () => ({
                  sessionFile: null,
                  sessionsDir: "/ignored",
                  mirrorFor: () => "refused",
                  sent: () => {},
                }),
              },
              logger: silentLogger,
            }),
        }
      : {}),
  });
  const papHome = join(bed.dir, "pap");
  if (!vm) mkdirSync(join(papHome, "agents", ID), { recursive: true, mode: 0o700 });
  const agents: SessionsAgentDeps = {
    profileOf: (ownerId, agentId) =>
      ownerId === "u1" && agentId === ID
        ? {
            input: AgentInput.parse({
              name: "Atlas",
              mode: "full-access",
              sandbox: { required: world.profile.sandboxRequired, network: true },
            }),
            name: "Atlas",
            quarantined: world.profile.quarantined,
          }
        : null,
    vaultOf: () => (world.reads.vault++, { TOKEN: "s3cret" }),
    onceOf: () => (world.reads.once++, []),
    probe: { ensure: async () => (world.reads.probe++, { usable: true as const, path: "/usr/bin/bwrap" }) },
    ...(vm
      ? {
          vmLayoutOf: (row) =>
            row.agentId === undefined
              ? null
              : layoutOf("process", papHome, { agentId: row.agentId, taskKey: taskKeyOf(row) }),
          agentRunsInVm: () => true,
        }
      : {}),
  };
  bed.service.agent.setAgentPorts({ agents });
  return { papHome };
}
const thread = () =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" });
const vmOf = (index: number): InitRecord["vm"] => initRecordOf(bed.spawned[index])?.vm;

describe("agent sessions in vm mode (T8a)", () => {
  it("starts a thread through the runtime with the VM's init, never the host's", async () => {
    const { papHome } = setup();
    const { sessionId } = await thread();
    expect(world.specs).toEqual([
      expect.objectContaining({ agentId: ID, kind: "thread", taskKey: null, image: IMAGE }),
    ]);
    const init = initRecordOf(bed.spawned[0]);
    const layout = layoutOf("process", papHome, { agentId: ID, taskKey: null });
    expect(init).toMatchObject({ cwd: layout.home, agentDir: layout.piAgentDir, papSessionId: sessionId });
    expect(vmOf(0)).toMatchObject({ layout, bwrap: "/usr/bin/bwrap", rootView: "read-only" });
    for (const key of ["sandbox", "vault", "once", "memory", "testProviderScript"])
      expect(init).not.toHaveProperty(key);
    expect(JSON.stringify(init)).not.toContain("s3cret");
    expect(JSON.stringify(init)).not.toContain(papHome + "/agents");
    expect(bed.spawned[0]?.sent.filter((record) => record.type === "init")).toHaveLength(1);
  });
  it("the VM rows get no host probe, no vault read, no one-use values and no host home", async () => {
    const { papHome } = setup();
    await thread();
    expect(world.reads).toEqual({ probe: 0, vault: 0, once: 0 });
    expect(() => statSync(join(papHome, "agents", ID))).toThrow();
    expect(statSync(join(papHome, "agents", ".mirrors", ID)).mode & 0o777).toBe(0o700);
  });
  it("a child of the thread spawns through the runtime as kind thread", async () => {
    setup();
    const parent = await thread();
    await bed.service.child.createChildSession({ ownerId: "u1", parentSessionId: parent.sessionId });
    expect(world.specs.map((spec) => spec.kind)).toEqual(["thread", "thread"]);
    expect(vmOf(1)).toBeDefined();
  });
  it("an isolated task spawns as kind isolated with its id without dashes", async () => {
    const id = randomUUID();
    setup({ newId: () => id });
    const scratch = join(bed.dir, "pap", "agents", ".runs", ID, id);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "task",
      scratch,
      task: { mode: "supervised", tools: ["bash"], preset: "full", tainted: false },
    });
    expect(world.specs).toEqual([
      expect.objectContaining({ kind: "isolated", taskKey: id.replaceAll("-", "") }),
    ]);
  });
  it("a plain session still forks a host worker, with a host init", async () => {
    setup();
    await bed.service.create(bed.work, OWNER);
    expect(world.specs).toEqual([]);
    expect(bed.spawned).toHaveLength(1);
    expect(initRecordOf(bed.spawned[0])).not.toHaveProperty("vm");
  });
  it("a VM row without a launcher (host mode with the layout wired) is refused internal: nothing spawns", async () => {
    setup({}, false);
    bed.service.agent.setAgentPorts({
      agents: {
        profileOf: () => ({ input: AgentInput.parse({ name: "A" }), name: "A", quarantined: false }),
        probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
        vmLayoutOf: (row) => layoutOf("process", "/p", { agentId: row.agentId ?? ID, taskKey: null }),
      },
    });
    expect(await codeOf(thread())).toBe("internal");
    expect(bed.spawned).toHaveLength(0);
  });
  it("memory trust is not recorded for a VM thread: a taint does not release its worker", async () => {
    const policy = fakePolicyPort();
    setup({ policy });
    const { sessionId } = await thread();
    policy.markTainted("u1", sessionId);
    let ended = false;
    void bed.spawned[0]?.exited.then(() => (ended = true));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(ended).toBe(false);
  });
});

describe("a sandbox-only continuation counts a VM as sandboxed (R38, RT-10)", () => {
  const cold = async (): Promise<string> => {
    const { sessionId } = await thread();
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    return sessionId;
  };
  const prompt = (sessionId: string) =>
    bed.service.automation.prompt({ ownerId: "u1", sessionId, text: "go", sandboxedOnly: true });
  it("starts a cold VM thread whose profile has no host sandbox", async () => {
    setup();
    world.profile.sandboxRequired = false;
    const sessionId = await cold();
    await prompt(sessionId);
    expect(world.specs).toHaveLength(2);
    expect(bed.spawned).toHaveLength(2);
  });
  it("still refuses a cold host agent without a sandbox", async () => {
    setup({}, false);
    world.profile.sandboxRequired = false;
    const sessionId = await cold();
    expect(await codeOf(prompt(sessionId))).toBe("sandbox_unavailable");
  });
  it("sandboxed() is true for a live VM session", async () => {
    setup();
    world.profile.sandboxRequired = false;
    const { sessionId } = await thread();
    await expect(prompt(sessionId)).resolves.toBeDefined();
  });
  it("sandboxed() stays false for a live host agent without a sandbox", async () => {
    setup({}, false);
    world.profile.sandboxRequired = false;
    const { sessionId } = await thread();
    expect(await codeOf(prompt(sessionId))).toBe("sandbox_unavailable");
  });
});

describe("capacity of VM launches (R29)", () => {
  it("passes with the free-memory floor unmet, and fails at PAP_MAX_WORKERS", async () => {
    setup({ limits: { maxWorkers: 3, minFreeMemMb: 100_000 }, freeMemMb: 1 });
    await thread();
    expect(bed.spawned).toHaveLength(1);
    // A plain session still meets the floor.
    expect(await codeOf(bed.service.create(bed.work, OWNER))).toBe("capacity");
  });
  it("counts a VM that is still booting against the cap", async () => {
    setup({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    world.hold = true;
    const first = thread();
    await vi.waitFor(() => expect(world.specs).toHaveLength(1));
    expect(await codeOf(thread())).toBe("capacity");
    world.release();
    await first;
    expect(world.specs).toHaveLength(1);
  });
});

describe("what the VM boot may change (fail closed)", () => {
  it("stops the worker and refuses the start when the agent is quarantined during the boot wait", async () => {
    setup();
    world.hold = true;
    const starting = thread();
    await vi.waitFor(() => expect(world.specs).toHaveLength(1));
    world.profile.quarantined = true;
    world.release();
    expect(await codeOf(starting)).toBe("agent_paused");
    expect(bed.spawned).toHaveLength(1);
    expect(bed.spawned[0]?.stopped()).toBe(true);
    expect(bed.spawned[0]?.sent.filter((record) => record.type === "init")).toEqual([]);
  });
});

describe("a shutdown during the VM boot (fail closed)", () => {
  it("stops the worker and refuses the start", async () => {
    setup();
    world.hold = true;
    const starting = thread();
    await vi.waitFor(() => expect(world.specs).toHaveLength(1));
    const closing = bed.service.shutdownAll();
    world.release();
    expect(await codeOf(starting)).toBe("capacity");
    await closing;
    expect(bed.spawned[0]?.stopped()).toBe(true);
  });
});

describe("RT-10: a full-access VM thread's continuation is not held", () => {
  // Mutant: the VM line of sandboxedThread removed (runs/resume.ts `heldForFullAccess` would hold every continuation).
  it("sandboxedThread is true for a VM thread whose profile has no host sandbox, false for a host one", async () => {
    setup();
    world.profile.sandboxRequired = false;
    const vm = await thread();
    expect(bed.service.agent.sandboxedThread("u1", vm.sessionId)).toBe(true);
    expect(bed.service.agent.sandboxedThread("u2", vm.sessionId)).toBe(false);
    await bed.dispose();
    setup({}, false);
    world.profile.sandboxRequired = false;
    const host = await thread();
    expect(bed.service.agent.sandboxedThread("u1", host.sessionId)).toBe(false);
  });
});

describe("a booting VM and a cold reopen (R29)", () => {
  // Mutant: `used >= max` skipped for a VM launch.
  it("a cold VM reopen is refused capacity when the live workers are at the cap", async () => {
    setup({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    const { sessionId } = await thread();
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    await bed.service.create(bed.work, OWNER);
    await bed.service.create(bed.work, OWNER);
    expect(await codeOf(bed.service.reopen(sessionId, OWNER))).toBe("capacity");
    expect(world.specs).toHaveLength(1);
  });
  it("a reopen's VM that is still booting counts against the cap for the plain sessions meanwhile", async () => {
    setup({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    const { sessionId } = await thread();
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    world.hold = true;
    const reopening = bed.service.reopen(sessionId, OWNER);
    await vi.waitFor(() => expect(world.specs).toHaveLength(2));
    await bed.service.create(bed.work, OWNER);
    expect(await codeOf(bed.service.create(bed.work, OWNER))).toBe("capacity");
    world.release();
    await reopening;
  });
});

describe("the boot assertion of the agents ports (fail closed)", () => {
  it("setAgentPorts refuses an agents object without the VM wiring when the launcher exists", () => {
    setup();
    const base: SessionsAgentDeps = {
      profileOf: () => null,
      probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
    };
    expect(() => bed.service.agent.setAgentPorts({ agents: base })).toThrow(/vmLayoutOf/);
    expect(() =>
      bed.service.agent.setAgentPorts({ agents: { ...base, vmLayoutOf: () => null as VmLayout | null } }),
    ).toThrow(/agentRunsInVm/);
    expect(() =>
      bed.service.agent.setAgentPorts({
        agents: { ...base, vmLayoutOf: () => null, agentRunsInVm: () => true },
      }),
    ).not.toThrow();
  });
  it("host mode accepts the plain object", () => {
    setup({}, false);
    expect(() =>
      bed.service.agent.setAgentPorts({
        agents: { profileOf: () => null, probe: { ensure: async () => ({ usable: true, path: "/b" }) } },
      }),
    ).not.toThrow();
  });
});
