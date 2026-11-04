import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import { OVERVIEW_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  agent,
  boxOf,
  build,
  item,
  member,
  MEMBER,
  NOW,
  OWNER,
  project,
  session,
  task,
} from "./snapshot-bed.ts";

describe("owner view: the agents", () => {
  it("reads an agent that waits on an approval as waiting, with the Inbox item as its ask", () => {
    const approval = item({ id: "i1", agentId: "agent-a", detail: "push to main?" });
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-a", "needs_input")] },
      pending: { [OWNER]: [approval] },
      phases: { "agent:agent-a": "running" },
    });
    const box = boxOf(snapshot(OWNER, true).boxes, "agent-a");
    expect(box.state).toBe("waiting");
    expect(box.ask).toEqual({ source: "inbox", item: approval });
    expect(box.ref).toEqual({ kind: "agent", id: "agent-a" });
  });

  it("reads a thread dialog without an Inbox item as a session ask", () => {
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-a", "needs_input")] },
      threads: {
        [OWNER]: {
          "thread-agent-a": { running: true, starting: false, needsInput: true, name: "Main thread" },
        },
      },
    });
    expect(boxOf(snapshot(OWNER, true).boxes, "agent-a").ask).toEqual({
      source: "session",
      sessionId: "thread-agent-a",
      title: "Main thread",
    });
  });

  it("carries alwaysOn for an agent and a box project, and false otherwise", () => {
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-on", "idle", { alwaysOn: true }), agent("agent-off", "idle")] },
      projects: { [OWNER]: [project("box-on", "box", { alwaysOn: true }), project("box-off", "box")] },
    });
    const { boxes } = snapshot(OWNER, true);
    expect(boxOf(boxes, "agent-on").alwaysOn).toBe(true);
    expect(boxOf(boxes, "agent-off").alwaysOn).toBe(false);
    expect(boxOf(boxes, "box-on").alwaysOn).toBe(true);
    expect(boxOf(boxes, "box-off").alwaysOn).toBe(false);
  });

  it("shows an idle thread as no activity, and a thread of another owner as nothing", () => {
    const idle = build({
      agents: { [OWNER]: [agent("agent-a", "idle")] },
      threads: {
        [OWNER]: { "thread-agent-a": { running: false, starting: false, needsInput: false, name: "Main" } },
      },
    });
    expect(boxOf(idle.snapshot(OWNER, true).boxes, "agent-a")).toMatchObject({ activities: [], busy: false });
    const foreign = build({
      agents: { [OWNER]: [agent("agent-a", "running")] },
      threads: {
        [MEMBER]: { "thread-agent-a": { running: true, starting: false, needsInput: false, name: "Theirs" } },
      },
    });
    expect(boxOf(foreign.snapshot(OWNER, true).boxes, "agent-a").activities).toEqual([]);
  });

  it("maps the rail words: failed, running, and a stopped agent with its next run", () => {
    const { snapshot } = build({
      agents: {
        [OWNER]: [agent("agent-f", "failed"), agent("agent-r", "running"), agent("agent-s", "idle")],
      },
      triggers: [
        {
          ownerId: OWNER,
          agentId: "agent-s",
          projectId: null,
          nextFireAt: NOW + 9000,
          name: "Evening pulse",
        },
        { ownerId: OWNER, agentId: "agent-s", projectId: null, nextFireAt: NOW + 5000, name: "Early pulse" },
        { ownerId: OWNER, agentId: "agent-s", projectId: null, nextFireAt: null, name: "Never" },
        { ownerId: MEMBER, agentId: "agent-s", projectId: null, nextFireAt: NOW + 1, name: "Foreign" },
      ],
    });
    const { boxes } = snapshot(OWNER, true);
    expect(boxOf(boxes, "agent-f").state).toBe("failed");
    expect(boxOf(boxes, "agent-r").state).toBe("running");
    const stopped = boxOf(boxes, "agent-s");
    expect(stopped.state).toBe("stopped");
    expect(stopped.nextRun).toEqual({ at: NOW + 5000, name: "Early pulse" });
  });

  it("shows a starting VM as starting and counts the box's reserved memory and its need", () => {
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-a", "idle", { memoryMb: 2048 })] },
      phases: { "agent:agent-a": "starting" },
      reserved: { "agent:agent-a": 2560 },
    });
    const box = boxOf(snapshot(OWNER, true).boxes, "agent-a");
    expect(box.state).toBe("starting");
    expect(box.phase).toBe("starting");
    expect(box.reservedMb).toBe(2560);
    expect(box.needMb).toBe(2048 + VM_OVERHEAD_MB);
  });

  it("lists the thread and the running tasks as activities, a task stoppable", () => {
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-a", "running")] },
      threads: {
        [OWNER]: { "thread-agent-a": { running: true, starting: false, needsInput: false, name: "Main" } },
      },
      tasks: {
        [OWNER]: [
          task({ id: "t1", agentId: "agent-a", title: "Weekly scan", startedAt: NOW - 100 }),
          task({ id: "t2", agentId: "agent-a", state: "done", title: "Old", endedAt: NOW - 50 }),
        ],
      },
      live: { "thread-agent-a": NOW - 900 },
    });
    const box = boxOf(snapshot(OWNER, true).boxes, "agent-a");
    expect(box.activities).toEqual([
      { kind: "thread", id: "thread-agent-a", title: "Main", since: NOW - 900, stoppable: false },
      { kind: "task", id: "t1", title: "Weekly scan", since: NOW - 100, stoppable: true },
    ]);
    expect(box.busy).toBe(true);
    expect(box.more).toBe(0);
  });
});

describe("owner view: the projects", () => {
  it("reads a session dialog with no Inbox item as a session ask and the project as waiting", () => {
    const { snapshot } = build({
      projects: { [OWNER]: [project("p1", "box")] },
      sessions: {
        [OWNER]: [
          session({ id: "s1", projectId: "p1", name: "Refactor", needsInput: true, status: "running" }),
        ],
      },
      phases: { "project:p1": "running" },
    });
    const box = boxOf(snapshot(OWNER, true).boxes, "p1");
    expect(box.state).toBe("waiting");
    expect(box.ask).toEqual({ source: "session", sessionId: "s1", title: "Refactor" });
  });

  it("takes the Inbox item of a task of the project as its ask", () => {
    const waiting = item({ id: "i2", kind: "task_needs_input", taskId: "t9", sessionId: "s9" });
    const { snapshot } = build({
      projects: { [OWNER]: [project("p1", "box")] },
      tasks: { [OWNER]: [task({ id: "t9", projectId: "p1", needsInput: true, sessionId: "s9" })] },
      sessions: { [OWNER]: [session({ id: "s9", projectId: "p1", needsInput: true, status: "running" })] },
      pending: { [OWNER]: [waiting] },
    });
    const box = boxOf(snapshot(OWNER, true).boxes, "p1");
    expect(box.state).toBe("waiting");
    expect(box.ask).toEqual({ source: "inbox", item: waiting });
    expect(box.activities.map((one) => one.kind)).toEqual(["task"]);
  });

  it("reads a project with an open Inbox item of its session as waiting, whatever its sessions say", () => {
    const waiting = item({ id: "i3", kind: "task_needs_input", sessionId: "s1" });
    const { snapshot } = build({
      projects: { [OWNER]: [project("p1", "box")] },
      sessions: { [OWNER]: [session({ id: "s1", projectId: "p1", status: "running" })] },
      pending: { [OWNER]: [waiting] },
    });
    expect(boxOf(snapshot(OWNER, true).boxes, "p1")).toMatchObject({
      state: "waiting",
      ask: { source: "inbox", item: waiting },
    });
  });

  it("reads a project whose newest task failed with nothing run since as failed", () => {
    const { snapshot } = build({
      projects: { [OWNER]: [project("p1", "box")] },
      tasks: {
        [OWNER]: [
          task({
            id: "t1",
            projectId: "p1",
            state: "failed",
            createdAt: NOW - 900,
            endedAt: NOW - 500,
            sessionId: "st1",
          }),
          task({ id: "t0", projectId: "p1", state: "done", createdAt: NOW - 2000, endedAt: NOW - 1900 }),
        ],
      },
      sessions: {
        [OWNER]: [
          session({ id: "st1", projectId: "p1", updatedAt: NOW - 400 }),
          session({ id: "old", projectId: "p1", updatedAt: NOW - 800 }),
        ],
      },
    });
    expect(boxOf(snapshot(OWNER, true).boxes, "p1").state).toBe("failed");
  });

  it("does not read a failed task as the failure once a session ran after it", () => {
    const { snapshot } = build({
      projects: { [OWNER]: [project("p1", "box")] },
      tasks: { [OWNER]: [task({ id: "t1", projectId: "p1", state: "failed", endedAt: NOW - 500 })] },
      sessions: { [OWNER]: [session({ id: "later", projectId: "p1", updatedAt: NOW - 100 })] },
    });
    expect(boxOf(snapshot(OWNER, true).boxes, "p1").state).toBe("stopped");
  });

  it("does not read an older failed task as the failure when a newer task did not fail", () => {
    const { snapshot } = build({
      projects: { [OWNER]: [project("p1", "box")] },
      tasks: {
        [OWNER]: [
          task({ id: "t2", projectId: "p1", state: "done", createdAt: NOW - 100, endedAt: NOW - 50 }),
          task({ id: "t1", projectId: "p1", state: "failed", createdAt: NOW - 900, endedAt: NOW - 500 }),
        ],
      },
    });
    expect(boxOf(snapshot(OWNER, true).boxes, "p1").state).toBe("stopped");
  });

  it("reads a box paused after crashes as failed while it is down, not once it runs again", () => {
    const down = build({
      projects: { [OWNER]: [project("p1", "box")] },
      paused: { [OWNER]: ["p1"] },
    });
    expect(boxOf(down.snapshot(OWNER, true).boxes, "p1").state).toBe("failed");
    const up = build({
      projects: { [OWNER]: [project("p1", "box")] },
      paused: { [OWNER]: ["p1"] },
      phases: { "project:p1": "running" },
    });
    expect(boxOf(up.snapshot(OWNER, true).boxes, "p1").state).toBe("running");
  });

  it("shows a host project only while one of its sessions runs, with no phase and no memory", () => {
    const quiet = build({
      projects: { [OWNER]: [project("h1", "host")] },
      sessions: { [OWNER]: [session({ id: "s1", projectId: "h1" })] },
    });
    expect(quiet.snapshot(OWNER, true).boxes).toEqual([]);
    const busy = build({
      projects: { [OWNER]: [project("h1", "host")] },
      sessions: { [OWNER]: [session({ id: "s1", projectId: "h1", status: "running", name: "Fix" })] },
      live: { s1: NOW - 700 },
    });
    const box = boxOf(busy.snapshot(OWNER, true).boxes, "h1");
    expect(box.ref).toEqual({ kind: "host", id: "h1" });
    expect(box.phase).toBeNull();
    expect(box.state).toBe("running");
    expect(box.needMb).toBe(0);
    expect(box.reservedMb).toBe(0);
    expect(box.activities).toEqual([
      { kind: "session", id: "s1", title: "Fix", since: NOW - 700, stoppable: false },
    ]);
  });

  it("caps the activities at three and counts the rest", () => {
    const sessions = ["a", "b", "c", "d", "e"].map((id) =>
      session({ id, projectId: "p1", status: "running", name: id }),
    );
    const { snapshot } = build({
      projects: { [OWNER]: [project("p1", "box")] },
      sessions: { [OWNER]: sessions },
    });
    const box = boxOf(snapshot(OWNER, true).boxes, "p1");
    expect(box.activities).toHaveLength(3);
    expect(box.more).toBe(2);
  });

  it("sorts by urgency with the stopped last and carries the cost of the day", () => {
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-z", "idle"), agent("agent-w", "needs_input")] },
      projects: { [OWNER]: [project("p1", "box")] },
      phases: { "project:p1": "running" },
      sessions: { [OWNER]: [session({ id: "s", projectId: "p1", status: "running" })] },
      spend: {
        projects: { p1: 1.25 },
        agents: { "agent-z": 0.5 },
        subscription: true,
        subscriptionProjects: ["p1"],
      },
    });
    const { boxes } = snapshot(OWNER, true);
    expect(boxes.map((one) => one.ref.id)).toEqual(["agent-w", "p1", "agent-z"]);
    expect(boxOf(boxes, "p1").costUsd).toBe(1.25);
    expect(boxOf(boxes, "p1").apiEquivalent).toBe(true);
    expect(boxOf(boxes, "agent-w").costUsd).toBe(0);
  });

  it("marks apiEquivalent per box: an API-billed box next to a subscription one is not", () => {
    const { snapshot } = build({
      agents: { [OWNER]: [agent("agent-sub", "idle"), agent("agent-api", "idle")] },
      projects: { [OWNER]: [project("p-api", "box")] },
      spend: {
        agents: { "agent-sub": 0.5, "agent-api": 0.7 },
        projects: { "p-api": 0.9 },
        subscription: true,
        subscriptionAgents: ["agent-sub"],
      },
    });
    const { boxes } = snapshot(OWNER, true);
    expect(boxOf(boxes, "agent-sub").apiEquivalent).toBe(true);
    expect(boxOf(boxes, "agent-api").apiEquivalent).toBe(false);
    expect(boxOf(boxes, "p-api").apiEquivalent).toBe(false);
  });
});

describe("fit and capacity (Review Focus 3)", () => {
  it("says fits at equality and not one megabyte past, from the same figures the start check uses", () => {
    const { snapshot } = build({
      memory: { usedMb: 3072, maxMb: 4096 },
      agents: {
        [OWNER]: [agent("agent-a", "idle", { memoryMb: 512 }), agent("agent-b", "idle", { memoryMb: 513 })],
      },
    });
    const { boxes } = snapshot(OWNER, true);
    expect(boxOf(boxes, "agent-a")).toMatchObject({ needMb: 1024, fits: true });
    expect(boxOf(boxes, "agent-b")).toMatchObject({ needMb: 1025, fits: false });
  });

  it("gives the owner the figures, FULL, the workers, the failures and the all-users cost", () => {
    const { snapshot } = build({
      memory: { usedMb: 3073, maxMb: 4096 },
      spend: { totalUsd: 1.5 },
      users: [
        member({ id: MEMBER, username: "mia", spentTodayUsd: 0.25 }),
        member({ id: "member-2", username: "off", disabled: true, spentTodayUsd: 0.5 }),
      ],
    });
    expect(snapshot(OWNER, true).capacity).toEqual({
      role: "owner",
      memory: { usedMb: 3073, maxMb: 4096, full: true },
      workers: { used: 2, max: 6 },
      cost: { totalUsd: 2.25, membersUsd: 0.75, apiEquivalent: false },
      failures: 3,
    });
  });

  it("reads memory as null and vmUsable false when the VM stack is unusable", () => {
    const { snapshot } = build({ agents: { [OWNER]: [agent("agent-a", "idle")] } });
    const view = snapshot(OWNER, false);
    expect(view.vmUsable).toBe(false);
    expect(view.capacity).toMatchObject({ role: "owner", memory: null });
    expect(boxOf(view.boxes, "agent-a").fits).toBe(false);
    expect(snapshot(OWNER, true).vmUsable).toBe(true);
  });

  it("cuts the member lines at the cap and the snapshot still parses", () => {
    const users = Array.from({ length: OVERVIEW_LIMITS.members + 1 }, (_, n) =>
      member({ id: `m${String(n).padStart(3, "0")}`, username: `user${String(n).padStart(3, "0")}` }),
    );
    const { snapshot } = build({ users });
    const view = snapshot(OWNER, true);
    expect(view.members).toHaveLength(OVERVIEW_LIMITS.members);
    expect(view.members[0]?.name).toBe("user000");
  });

  it("cuts the box cards at the cap", () => {
    const agents = Array.from({ length: OVERVIEW_LIMITS.boxes + 1 }, (_, n) =>
      agent(`a${String(n).padStart(3, "0")}`, "idle"),
    );
    const { snapshot } = build({ agents: { [OWNER]: agents } });
    expect(snapshot(OWNER, true).boxes).toHaveLength(OVERVIEW_LIMITS.boxes);
  });
});
