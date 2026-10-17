import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput, PolicyRules } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxProbe } from "../../kernel/sandbox/probe.ts";
import type { SessionsAgentDeps } from "./agent-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort, initRecordOf, policyUpdatesOf } from "./testing/fake-policy.ts";
import { codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

interface World {
  probe: SandboxProbe;
  input: AgentInput;
}
function setup(input: object = {}, options?: BedOptions): World {
  bed = build(options);
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  const world: World = {
    probe: { usable: true, path: "/usr/bin/bwrap" },
    input: AgentInput.parse({
      name: "Atlas",
      role: "Be brief.",
      mode: "full-access",
      allowHosts: ["api.example"],
      denylist: ["rm -rf *"],
      trustedSources: ["docs.example.com"],
      sandbox: { required: true, network: false },
      ...input,
    }),
  };
  const agents: SessionsAgentDeps = {
    profileOf: (ownerId, agentId) =>
      ownerId === "u1" && agentId === ID ? { input: world.input, name: "Atlas", quarantined: false } : null,
    vaultOf: () => ({ TOKEN: "v" }),
    probe: { ensure: async () => world.probe },
  };
  bed.service.agent.setAgentPorts({ agents });
  return world;
}
const thread = () =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" });
const child = (parent: string) =>
  bed.service.child.createChildSession({ ownerId: "u1", parentSessionId: parent });
const home = () => join(bed.dir, "pap", "agents", ID);
const rulesOf = (index: number) => PolicyRules.parse(initRecordOf(bed.spawned[index])?.policy);

describe("a child of an agent thread (RT-07, M11R136)", () => {
  it("keeps the agent on its row with the role child, in the agent's home", async () => {
    setup();
    const parent = await thread();
    const made = await child(parent.sessionId);
    expect(bed.store.get(made.sessionId)).toMatchObject({
      agentId: ID,
      agentRole: "child",
      parentSessionId: parent.sessionId,
      cwd: home(),
    });
    expect(initRecordOf(bed.spawned[1])).toMatchObject({ agent: { id: ID, name: "Atlas" } });
  });

  it("composes the agent's rules: profile, hosts, blocked commands, sandbox and home, with no platform op", async () => {
    setup();
    const parent = await thread();
    await child(parent.sessionId);
    expect(rulesOf(1)).toMatchObject({
      profile: "agent-thread",
      allowHosts: ["api.example"],
      agentHome: home(),
      agentScratch: null,
      sandbox: { required: true, network: false },
      autonomy: null,
      hostGrants: [],
      trustedSources: ["docs.example.com"],
    });
    expect(rulesOf(1).denylist).toContain("rm -rf *");
    expect(initRecordOf(bed.spawned[1])?.platform).toEqual({ ops: [] });
    expect(initRecordOf(bed.spawned[1])?.sandbox).toMatchObject({
      view: "host",
      home: home(),
      writable: home(),
    });
  });

  it("never carries the agent's mode: full-access becomes auto-accept-edits", async () => {
    setup({ mode: "full-access" });
    const parent = await thread();
    expect(rulesOf(0).approvalMode).toBe("full-access");
    await child(parent.sessionId);
    expect(rulesOf(1).approvalMode).toBe("auto-accept-edits");
  });

  it("has no vault and no one-use value in its init, whatever the agent holds", async () => {
    setup();
    const parent = await thread();
    await child(parent.sessionId);
    expect(initRecordOf(bed.spawned[0])?.vault).toEqual({ TOKEN: "v" });
    expect(initRecordOf(bed.spawned[1])).not.toHaveProperty("vault");
    expect(initRecordOf(bed.spawned[1])).not.toHaveProperty("once");
  });

  it("is not told of a vault change, while the thread is", async () => {
    setup();
    const parent = await thread();
    await child(parent.sessionId);
    const told = bed.service.agentSessions.sendToAgent("u1", ID, {
      type: "vault_update",
      vault: { TOKEN: "w" },
      once: [],
    });
    expect(told).toBe(1);
    const updates = (index: number) => bed.spawned[index]?.sent.filter((r) => r.type === "vault_update");
    expect(updates(0)).toHaveLength(1);
    expect(updates(1)).toEqual([]);
  });

  it("starts through the launch gate: no usable sandbox means sandbox_unavailable and no worker", async () => {
    const world = setup();
    const parent = await thread();
    world.probe = { usable: false, reason: "missing" };
    expect(await codeOf(child(parent.sessionId))).toBe("sandbox_unavailable");
    expect(bed.spawned).toHaveLength(1);
    expect(bed.store.listByOwner("u1")).toHaveLength(1);
  });

  it("a paused (quarantined) agent's child does not start either", async () => {
    setup();
    const parent = await thread();
    bed.service.agent.setAgentPorts({
      agents: {
        profileOf: () => ({ input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: true }),
        probe: { ensure: async () => ({ usable: true, path: "/usr/bin/bwrap" }) },
      },
    });
    expect(await codeOf(child(parent.sessionId))).toBe("agent_paused");
  });

  it("is a child of the thread only: a task of the agent cannot parent one", async () => {
    setup();
    const scratch = join(bed.dir, "pap", "agents", ".runs", ID, "0a1b2c3d-0000-4000-8000-0123456789ab");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const task = await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "task",
      scratch,
      task: { mode: "supervised", tools: ["read"], preset: "read-only", tainted: false },
    });
    expect(await codeOf(child(task.sessionId))).toBe("bad_request");
  });
});

describe("a child of a plain session", () => {
  it("has no agent, no sandbox and no gate", async () => {
    setup();
    bed.service.agent.setAgentPorts({ agents: undefined });
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId);
    expect(bed.store.get(made.sessionId)?.agentId).toBeUndefined();
    expect(initRecordOf(bed.spawned[1])).not.toHaveProperty("sandbox");
    expect(initRecordOf(bed.spawned[1])).not.toHaveProperty("agent");
  });
});

describe("the cells of the subagent.run op that run (M11R137, M11R36)", () => {
  const platform = { available: () => true } as never;
  const opsAt = (index: number) => initRecordOf(bed.spawned[index])?.platform?.ops ?? [];

  it("a plain, a lane and an agent-thread worker start with the tool, a child and an isolated task without", async () => {
    setup({}, { limits: { maxWorkers: 10, minFreeMemMb: 0 } });
    bed.service.agent.setAgentPorts({ platform, inLane: (_owner, cwd) => cwd === bed.otherWork });
    const plain = await bed.service.create(bed.work, OWNER);
    const lane = await bed.service.create(bed.otherWork, OWNER);
    const agent = await thread();
    const made = await child(agent.sessionId);
    const plainChild = await child(plain.sessionId);
    const scratch = join(bed.dir, "pap", "agents", ".runs", ID, "0a1b2c3d-0000-4000-8000-0123456789ab");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "task",
      scratch,
      task: { mode: "supervised", tools: ["read"], preset: "read-only", tainted: false },
    });
    expect([plain, lane, agent].map((_, index) => opsAt(index).includes("subagent.run"))).toEqual([
      true,
      true,
      true,
    ]);
    expect([made, plainChild].map(({ sessionId }) => bed.store.get(sessionId)?.parentSessionId)).toEqual([
      agent.sessionId,
      plain.sessionId,
    ]);
    // Spawn order: plain 0, lane 1, agent 2, its child 3, the plain's child 4, the task 5.
    expect([opsAt(3), opsAt(4), opsAt(5)]).toEqual([[], [], []]);
  });

  it("starts no worker with the tool while no handler is registered or its switch is off", async () => {
    setup();
    bed.service.agent.setAgentPorts({
      platform: { available: (op: string) => op !== "subagent.run" } as never,
    });
    await bed.service.create(bed.work, OWNER);
    expect(opsAt(0)).not.toContain("subagent.run");
  });
});

describe("a child is never above its agent (review I3)", () => {
  const lastRules = (index: number) =>
    PolicyRules.parse((policyUpdatesOf(bed.spawned[index]).at(-1) as { rules: unknown }).rules);

  it("is held to the agent's mode when the owner raises the child's own", async () => {
    const policy = fakePolicyPort();
    setup({ mode: "full-access" }, { policy, limits: { maxWorkers: 10, minFreeMemMb: 0 } });
    const parent = await thread();
    const made = await child(parent.sessionId);
    policy.setMode("u1", made.sessionId, "full-access");
    expect(lastRules(1).approvalMode).toBe("auto-accept-edits");
    policy.setMode("u1", made.sessionId, "supervised");
    expect(lastRules(1).approvalMode).toBe("supervised");
  });

  it("starts at the agent's lowered mode after the agent was lowered", async () => {
    const policy = fakePolicyPort();
    const world = setup({ mode: "full-access" }, { policy });
    const parent = await thread();
    const made = await child(parent.sessionId);
    expect(rulesOf(1).approvalMode).toBe("auto-accept-edits");
    world.input = AgentInput.parse({ name: "Atlas", mode: "read-only", sandbox: { required: true } });
    bed.service.releaseIdle(OWNER.userId, made.sessionId);
    await bed.spawned[1]?.exited;
    await bed.service.reopen(made.sessionId, OWNER);
    expect(rulesOf(2).approvalMode).toBe("read-only");
  });

  it("reports the agent's mode, capped, and clamps the owner's tool choice to the agent's preset", async () => {
    setup({ mode: "full-access", preset: "read-only" });
    const parent = await thread();
    const made = await child(parent.sessionId);
    expect(bed.service.agent.modeOf("u1", made.sessionId)).toBe("auto-accept-edits");
    const row = bed.store.get(made.sessionId);
    if (!row) throw new Error("no row");
    expect(bed.service.agent.clampPreset(row, "full")).toBe("read-only");
    expect(bed.service.agent.clampPreset(row, "chat")).toBe("chat");
  });

  it("narrows a reopened child's stored preset to its agent's, and never widens it", async () => {
    const world = setup({ preset: "full" }, { limits: { maxWorkers: 10, minFreeMemMb: 0 } });
    const parent = await thread();
    const made = await child(parent.sessionId);
    expect(initRecordOf(bed.spawned[1])?.tools?.preset).toBe("full");
    const reopen = async (index: number) => {
      bed.service.releaseIdle(OWNER.userId, made.sessionId);
      await bed.spawned[index]?.exited;
      await bed.service.reopen(made.sessionId, OWNER);
    };
    world.input = AgentInput.parse({ ...world.input, preset: "read-only" });
    await reopen(1);
    expect(initRecordOf(bed.spawned[2])?.tools?.preset).toBe("read-only");
    expect(bed.store.get(made.sessionId)?.toolPreset).toBe("read-only");
    world.input = AgentInput.parse({ ...world.input, preset: "full" });
    await reopen(2);
    expect(initRecordOf(bed.spawned[3])?.tools?.preset).toBe("read-only");
  });
});
