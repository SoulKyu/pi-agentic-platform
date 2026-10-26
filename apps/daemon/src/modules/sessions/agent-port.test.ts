import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { layoutOf } from "../agent-vm/index.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import type { SessionsAgentDeps } from "./agent-gate.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { initRecordOf } from "./testing/fake-policy.ts";
import { codeOf } from "./testing/helpers.ts";
import { fakeVmLaunch } from "./testing/fake-vm-launch.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const ID = "atlas-1a2b";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
// Agents run in microVMs only: the launch goes through the VM launcher (its worker is the bed's fake one).
const build = (options?: BedOptions) =>
  createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    { ...options, vmLaunch: fakeVmLaunch },
  );
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

interface World {
  /** This machine's VM stack goes away. */
  vmGone(): void;
  /** How many launch gates ran to the end (the Claude Code environment is asked once per gate). */
  ensured: number;
  profile: { input: AgentInput; name: string; quarantined: boolean } | null;
}
function setup(options?: BedOptions): World {
  bed = build(options);
  const world: World = {
    vmGone: () => {},
    ensured: 0,
    profile: {
      input: AgentInput.parse({ name: "Atlas", role: "Be brief." }),
      name: "Atlas",
      quarantined: false,
    },
  };
  const agents: SessionsAgentDeps = {
    profileOf: (ownerId, agentId) => (ownerId === "u1" && agentId === ID ? world.profile : null),
    claudeEnvOf: async () => {
      world.ensured += 1;
      return {};
    },
  };
  bed.service.agent.setAgentPorts({ agents });
  world.vmGone = () =>
    bed.service.agent.setAgentPorts({
      agents: { ...agents, vmLayoutOf: () => null },
    });
  return world;
}
const thread = () =>
  bed.service.agentSessions.createAgentSession({ ownerId: "u1", agentId: ID, role: "thread" });
const home = () => join(bed.dir, "pap", "agents", ID);
/** Where the VM's home is (the process backend's layout). */
const vmHome = (taskKey: string | null = null) =>
  layoutOf("process", join(bed.dir, "pap"), { agentId: ID, taskKey }).home;

describe("createAgentSession (M11R50)", () => {
  it("stores the binding with the row and starts through launch: the gate runs once, the init carries the facts", async () => {
    const world = setup();
    const { sessionId } = await thread();
    expect(bed.store.get(sessionId)).toMatchObject({
      agentId: ID,
      agentRole: "thread",
      cwd: home(),
      ownerId: "u1",
    });
    expect(world.ensured).toBe(1);
    expect(bed.spawned).toHaveLength(1);
    const init = initRecordOf(bed.spawned[0]);
    expect(init).toMatchObject({
      cwd: home(),
      agent: { id: ID, name: "Atlas", role: "Be brief." },
      policy: { profile: "agent-thread", agentHome: vmHome() },
    });
    expect(init).not.toHaveProperty("sandbox");
  });

  it("an unknown or another owner's agent is not_found, and nothing starts", async () => {
    setup();
    const other = bed.service.agentSessions.createAgentSession({
      ownerId: "u2",
      agentId: ID,
      role: "thread",
    });
    expect(await codeOf(other)).toBe("not_found");
    expect(bed.spawned).toHaveLength(0);
  });

  it("never takes the owner's last worker (M10R154), and answers capacity before the gate opens anything", async () => {
    const world = setup({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    await bed.service.create(bed.work, OWNER);
    expect(await codeOf(thread())).toBe("capacity");
    expect(world.ensured).toBe(0);
  });

  it("two creations at once leave the owner's last worker free: the second gets capacity (M10R154)", async () => {
    setup({ limits: { maxWorkers: 3, minFreeMemMb: 0 } });
    await bed.service.create(bed.work, OWNER);
    const results = await Promise.all([codeOf(thread()), codeOf(thread())]);
    expect(results).toEqual([null, "capacity"]);
    expect(bed.spawned).toHaveLength(2);
  });

  it("a cold agent thread prompted by the runner does not take the last worker either, even with two at once", async () => {
    const world = setup({ limits: { maxWorkers: 3, minFreeMemMb: 0 } });
    const first = await thread();
    bed.service.agentSessions.releaseIdle("u1", first.sessionId);
    await bed.spawned[0]?.exited;
    await bed.service.create(bed.work, OWNER);
    const second = await thread();
    bed.service.agentSessions.releaseIdle("u1", second.sessionId);
    await bed.spawned[2]?.exited;
    const prompt = (id: string) =>
      codeOf(bed.service.automation.prompt({ ownerId: "u1", sessionId: id, text: "go" }));
    expect(await Promise.all([prompt(first.sessionId), prompt(second.sessionId)])).toEqual([
      null,
      "capacity",
    ]);
    expect(world.ensured).toBe(4);
  });

  it("a task session stores its policy and works in its own VM's home", async () => {
    const world = setup();
    const scratch = join(bed.dir, "pap", "agents", ".runs", ID, TASK);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const { sessionId } = await bed.service.agentSessions.createAgentSession({
      ownerId: "u1",
      agentId: ID,
      role: "task",
      scratch,
      task: { mode: "supervised", tools: ["read", "bash"], preset: "full", tainted: false },
    });
    expect(world.ensured).toBe(1);
    expect(bed.store.get(sessionId)).toMatchObject({ agentRole: "task", cwd: scratch });
    expect(initRecordOf(bed.spawned[0])).toMatchObject({
      policy: {
        profile: "isolated-task",
        approvalMode: "supervised",
        agentScratch: vmHome(sessionId.replaceAll("-", "")),
      },
    });
  });

  it("sends the profile's model and thinking level after ready, without persisting them", async () => {
    const world = setup({ replies: { set_model: { success: true }, set_thinking_level: { success: true } } });
    world.profile = {
      input: AgentInput.parse({ name: "Atlas", model: { provider: "p", modelId: "m" }, thinking: "high" }),
      name: "Atlas",
      quarantined: false,
    };
    await thread();
    expect(bed.spawned[0]?.requests).toEqual([
      expect.objectContaining({ type: "set_model", provider: "p", modelId: "m" }),
      expect.objectContaining({ type: "set_thinking_level", level: "high" }),
      // The VM start keeps the box's models in the background.
      expect.objectContaining({ type: "get_available_models" }),
    ]);
  });
});

describe("every launch runs the gate (M11R53, RT-06)", () => {
  it("a thread released while idle, then the VM stack gone: the prompt is sandbox_unavailable and nothing spawns", async () => {
    const world = setup();
    const { sessionId } = await thread();
    expect(bed.service.agentSessions.releaseIdle("u1", sessionId)).toBe("released");
    await bed.spawned[0]?.exited;
    world.vmGone();
    expect(await codeOf(bed.service.prompt({ sessionId, text: "hi" }, OWNER))).toBe("sandbox_unavailable");
    expect(bed.spawned).toHaveLength(1);
    expect(world.ensured).toBe(1);
  });

  it("an archived thread of a deleted agent, unarchived and prompted, is not_found", async () => {
    const world = setup();
    const { sessionId } = await thread();
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    bed.service.mark({ sessionId, change: { kind: "archive" } }, OWNER);
    world.profile = null;
    bed.service.mark({ sessionId, change: { kind: "unarchive" } }, OWNER);
    expect(await codeOf(bed.service.prompt({ sessionId, text: "hi" }, OWNER))).toBe("not_found");
    expect(bed.spawned).toHaveLength(1);
  });

  it("a quarantined agent's thread does not start again: agent_paused", async () => {
    const world = setup();
    const { sessionId } = await thread();
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    if (world.profile) world.profile = { ...world.profile, quarantined: true };
    expect(await codeOf(bed.service.reopen(sessionId, OWNER))).toBe("agent_paused");
  });

  it("a worker crash then a reopen runs the gate again", async () => {
    const world = setup();
    const { sessionId } = await thread();
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.spawned[0]?.exited;
    await bed.service.reopen(sessionId, OWNER);
    expect(bed.spawned).toHaveLength(2);
    expect(world.ensured).toBe(2);
  });
});

describe("threadState", () => {
  it("is null for a session that is not the owner's, and tells a quiet running worker", async () => {
    setup();
    const { sessionId } = await thread();
    expect(bed.service.agentSessions.threadState("u2", sessionId)).toBeNull();
    expect(bed.service.agentSessions.threadState("u1", sessionId)).toEqual({
      running: false,
      needsInput: false,
      starting: false,
      archived: false,
    });
  });
});

describe("attention of an agent's session (M10R33, M11R56)", () => {
  it("an open question reaches onAttention while the session stays out of the sidebar", async () => {
    setup();
    const shell: unknown[] = [];
    bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
    bed.hub.open({
      connectionId: "c1",
      sub: "s1",
      stream: "shell",
      key: "u1",
      after: undefined,
      send: (frame) => void shell.push(frame.event),
    });
    const { sessionId } = await thread();
    const seen: Array<[string, boolean]> = [];
    bed.service.automation.onAttention((id, needs) => void seen.push([id, needs]));
    bed.spawned[0]?.emit({
      type: "approval_request",
      id: "d1",
      category: "exec",
      title: "Run?",
      message: "bash: x",
      answers: ["deny", "once"],
      tool: "bash",
      key: "a".repeat(64),
      tainted: false,
    });
    await bed.clock.advance(1_000);
    expect(seen).toEqual([[sessionId, true]]);
    expect(shell.filter((event) => (event as { kind: string }).kind === "session")).toEqual([]);
  });
});

describe("the sidebar leaves the sessions of agents out (M11R56)", () => {
  it("the snapshot, the events and the project filing do not name them; the plain control does", async () => {
    setup();
    const frames: unknown[] = [];
    bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
    bed.hub.open({
      connectionId: "c1",
      sub: "s1",
      stream: "shell",
      key: "u1",
      after: undefined,
      send: (frame) => void frames.push(frame.event),
    });
    const plain = await bed.service.create(bed.work, OWNER);
    const { sessionId } = await thread();
    // Both workers start a run: the status of each reaches the sidebar's publisher.
    bed.emit(0, { type: "agent_start" });
    bed.emit(1, { type: "agent_start" });
    await bed.clock.advance(1_000);
    const named = (): string[] =>
      (frames as Array<{ kind: string; session?: { id: string } }>).flatMap((event) =>
        event.kind === "session" && event.session ? [event.session.id] : [],
      );
    expect(named()).toContain(plain.sessionId);
    expect(named()).not.toContain(sessionId);
    const snapshot = bed.service.shellSnapshot("u1") as { sessions: Array<{ id: string }> };
    expect(snapshot.sessions.map((row) => row.id)).toEqual([plain.sessionId]);
    expect(bed.service.summary(sessionId, "u1")).toMatchObject({ id: sessionId });
    expect(bed.db.get("SELECT project_id AS p FROM sessions WHERE id = $id", { id: sessionId })).toEqual({
      p: null,
    });
  });
});

const pushedMode = () =>
  (
    bed.spawned[0]?.sent.filter((record) => record.type === "policy_update").at(-1) as
      { rules: { approvalMode: string } } | undefined
  )?.rules.approvalMode;

describe("the owner's mode switch on an agent thread (W5-R23)", () => {
  it("an emergency read-only applies at once and the view says so; a looser mode is not applied", async () => {
    const policy = fakePolicyPort();
    setup({ policy });
    const { sessionId } = await thread();
    expect(initRecordOf(bed.spawned[0]).policy).toMatchObject({ approvalMode: "auto-accept-edits" });
    policy.setMode("u1", sessionId, "read-only");
    await bed.clock.advance(0);
    expect(pushedMode()).toBe("read-only");
    expect(await bed.snapshot(sessionId)).toMatchObject({
      policy: { mode: "read-only", explicit: true },
    });
    policy.setMode("u1", sessionId, "full-access");
    await bed.clock.advance(0);
    expect(pushedMode()).toBe("auto-accept-edits");
    expect(await bed.snapshot(sessionId)).toMatchObject({
      policy: { mode: "auto-accept-edits", explicit: false },
    });
  });
});

describe("a running worker keeps the profile it started with (W5-R26)", () => {
  const edit = (world: World, input: object) => {
    world.profile = {
      input: AgentInput.parse({ name: "Atlas", role: "Be brief.", ...input }),
      name: "Atlas",
      quarantined: false,
    };
  };

  it("an edit of the profile changes neither the pushes nor the view until the next start", async () => {
    const policy = fakePolicyPort();
    const world = setup({ policy });
    const { sessionId } = await thread();
    edit(world, { mode: "full-access" });
    policy.setMode("u1", sessionId, "read-only");
    await bed.clock.advance(0);
    expect(pushedMode()).toBe("read-only");
    policy.setMode("u1", sessionId, "full-access");
    await bed.clock.advance(0);
    expect(pushedMode()).toBe("auto-accept-edits");
    expect(await bed.snapshot(sessionId)).toMatchObject({ policy: { mode: "auto-accept-edits" } });
    expect(bed.service.modeOf("u1", sessionId)).toBe("auto-accept-edits");
    // The next start reads the edited profile.
    bed.service.agentSessions.releaseIdle("u1", sessionId);
    await bed.spawned[0]?.exited;
    // Cold again: the snapshot is gone and the view follows the edited profile.
    expect(bed.service.modeOf("u1", sessionId)).toBe("full-access");
    await bed.service.reopen(sessionId, OWNER);
    expect(initRecordOf(bed.spawned[1]).policy).toMatchObject({ approvalMode: "full-access" });
  });

  it("the tool preset of a running thread can be narrowed and never widened past the start-time profile", async () => {
    const world = setup({ replies: { set_tools: { success: true } } });
    edit(world, { preset: "default" });
    const { sessionId } = await thread();
    edit(world, { preset: "full" });
    await bed.service.setTools({ sessionId, preset: "full" }, OWNER);
    expect(bed.store.toolPreset(sessionId)).toBe("default");
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    expect(bed.store.toolPreset(sessionId)).toBe("read-only");
    expect(bed.spawned[0]?.requests.filter((request) => request.type === "set_tools")).toEqual([
      expect.objectContaining({ preset: "default" }),
      expect.objectContaining({ preset: "read-only" }),
    ]);
  });
});

describe("the mode the usage resume reads (W5-R23, M10R104)", () => {
  it("an agent thread with a full-access profile and no session mode is full-access; a session read-only tightens it", async () => {
    const policy = fakePolicyPort();
    const world = setup({ policy });
    world.profile = {
      input: AgentInput.parse({ name: "Atlas", mode: "full-access" }),
      name: "Atlas",
      quarantined: false,
    };
    const { sessionId } = await thread();
    expect(bed.service.modeOf("u1", sessionId)).toBe("full-access");
    policy.setMode("u1", sessionId, "read-only");
    expect(bed.service.modeOf("u1", sessionId)).toBe("read-only");
  });

  it("a supervised profile is not full-access whatever the session says, and a plain session keeps its own mode", async () => {
    const policy = fakePolicyPort();
    const world = setup({ policy });
    world.profile = {
      input: AgentInput.parse({ name: "Atlas", mode: "supervised" }),
      name: "Atlas",
      quarantined: false,
    };
    const { sessionId } = await thread();
    policy.setMode("u1", sessionId, "full-access");
    expect(bed.service.modeOf("u1", sessionId)).toBe("supervised");
    const plain = await bed.service.create(bed.work, OWNER);
    policy.setMode("u1", plain.sessionId, "full-access");
    expect(bed.service.modeOf("u1", plain.sessionId)).toBe("full-access");
  });
});
