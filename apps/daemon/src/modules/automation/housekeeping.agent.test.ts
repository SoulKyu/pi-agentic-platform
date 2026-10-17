import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutbox } from "../../kernel/outbox/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { createHousekeeping } from "./housekeeping.ts";
import { createAgentScratchDropper, createAgentScratchSweeper } from "./runner-agent.ts";
import { createTaskStore } from "./tasks.ts";
import { AGENT, fakeAgentPorts } from "./testing/agent-fakes.ts";
import { createAutomationBed, type AutomationBed } from "./testing/bed.ts";

const DAY = 86_400_000;
const TASK = "0b1c2d3e-0001-4000-8000-000000000001";
const PROJECT_TASK = "project-task";

let bed: AutomationBed;
afterEach(() => bed.dispose());

type Port = Pick<SessionsAutomationPort, "state" | "lastActivityAt" | "deleteTaskSession">;

function setup(options: { sweep?: boolean } = {}) {
  bed = createAutomationBed();
  const store = createTaskStore(bed.db);
  const outbox = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
  const fakes = fakeAgentPorts(bed.dir);
  fakes.add();
  const activity = new Map<string, number>();
  const sessions = {
    state: vi.fn<Port["state"]>(() => ({ archived: true, running: false, needsInput: false })),
    lastActivityAt: vi.fn<Port["lastActivityAt"]>((sessionId) => activity.get(sessionId) ?? null),
    deleteTaskSession: vi.fn<Port["deleteTaskSession"]>(() => "deleted"),
  };
  const housekeeping = createHousekeeping({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    store,
    outbox,
    sessions,
    timeZone: () => "UTC",
    readOnly: false,
    dropScratch: createAgentScratchDropper(() => fakes.ports, bed.logger),
    sweepScratch: (options.sweep === false ? undefined : createAgentScratchSweeper)?.({
      ports: () => fakes.ports,
      hasTask: (id) => store.get(id) !== undefined,
      logger: bed.logger,
    }),
  });
  /** A task of the agent that ended `state` 40 days ago, with its folder on disk. */
  const ended = (id: string, state: "failed" | "cancelled", sessionId: string | null) => {
    finished(id, { agentId: AGENT, target: "isolated" }, sessionId ?? "none");
    bed.db.run("DROP TRIGGER IF EXISTS tasks_terminal_immutable");
    bed.db.run("UPDATE tasks SET state = $state, session_id = $sessionId WHERE id = $id", {
      id,
      state,
      sessionId,
    });
    fakes.ports.registry.openScratch("u1", AGENT, id);
  };
  const finished = (
    id: string,
    agent: { agentId: string; target: "isolated" | "thread" } | null,
    sessionId: string,
  ) => {
    store.insert({
      id,
      ownerId: "u1",
      triggerId: null,
      origin: "webhook",
      cwd: bed.folder,
      prompt: "p",
      tainted: false,
      gated: true,
      policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
      title: "Nightly",
      detail: null,
      retryOf: null,
      retryOnInterrupt: false,
      maxRunMs: 60_000,
      maxRunUsd: null,
      at: bed.clock.now() - 40 * DAY - 1_000,
      ...(agent ? { agentId: agent.agentId, target: agent.target } : {}),
    });
    const endedAt = bed.clock.now() - 40 * DAY;
    bed.db.run(
      "UPDATE tasks SET state = 'done', ended_at = $endedAt, session_id = $sessionId WHERE id = $id",
      {
        id,
        endedAt,
        sessionId,
      },
    );
    activity.set(sessionId, endedAt);
  };
  return { housekeeping, sessions, finished, ended, activity, fakes, store };
}

describe("the 30-day cleanup removes an isolated task's scratch folder (M11R180)", () => {
  it("removes it once the task's session is deleted", () => {
    const { housekeeping, finished, fakes } = setup();
    finished(TASK, { agentId: AGENT, target: "isolated" }, "s1");
    housekeeping.pass();
    expect(fakes.removed).toEqual([`${AGENT}/${TASK}`]);
    expect(bed.db.get("SELECT 1 AS n FROM tasks")).toBeUndefined();
  });

  it("removes it too when the session was gone already", () => {
    const { housekeeping, finished, sessions, fakes } = setup();
    sessions.state.mockReturnValue(null);
    finished(TASK, { agentId: AGENT, target: "isolated" }, "s1");
    housekeeping.pass();
    expect(fakes.removed).toEqual([`${AGENT}/${TASK}`]);
  });

  it("keeps it while the session is busy: the task and the folder wait for the next pass", () => {
    const { housekeeping, finished, sessions, fakes } = setup();
    sessions.deleteTaskSession.mockReturnValue("busy");
    finished(TASK, { agentId: AGENT, target: "isolated" }, "s1");
    housekeeping.pass();
    expect(fakes.removed).toEqual([]);
    expect(bed.db.get("SELECT 1 AS n FROM tasks")).toEqual({ n: 1 });
  });

  it("keeps it when the owner went back to the session: that session is theirs now", () => {
    const { housekeeping, finished, activity, fakes } = setup();
    finished(TASK, { agentId: AGENT, target: "isolated" }, "s1");
    activity.set("s1", bed.clock.now());
    housekeeping.pass();
    expect(fakes.removed).toEqual([]);
  });

  it("asks nothing for a project task or a task of the agent's thread", () => {
    const { housekeeping, finished, fakes } = setup();
    finished(PROJECT_TASK, null, "s2");
    finished("0b1c2d3e-0009-4000-8000-000000000009", { agentId: AGENT, target: "thread" }, "s3");
    housekeeping.pass();
    expect(fakes.removed).toEqual([]);
  });

  it("says a folder that cannot be removed, and the pass goes on", () => {
    const { housekeeping, finished, fakes } = setup();
    fakes.ports.registry.removeScratch = () => {
      throw new Error("busy device");
    };
    finished(TASK, { agentId: AGENT, target: "isolated" }, "s1");
    finished("0b1c2d3e-0002-4000-8000-000000000002", { agentId: AGENT, target: "isolated" }, "s2");
    housekeeping.pass();
    expect(bed.logs.filter((line) => line.msg === "agent_scratch_remove_failed")).toHaveLength(2);
    expect(bed.db.get("SELECT 1 AS n FROM tasks")).toBeUndefined();
  });
});

describe("folders of tasks that did not end done (I3)", () => {
  const OTHER = "0b1c2d3e-0002-4000-8000-000000000002";

  it("a failed and a cancelled isolated task lose their folder with their row when no session is left", () => {
    // No sweep here: the row's own removal drops the folder.
    const { housekeeping, ended, fakes } = setup({ sweep: false });
    ended(TASK, "failed", null);
    ended(OTHER, "cancelled", null);
    expect(fakes.scratchExists(AGENT, TASK)).toBe(true);
    housekeeping.pass();
    expect(bed.db.get("SELECT 1 AS n FROM tasks")).toBeUndefined();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(false);
    expect(fakes.scratchExists(AGENT, OTHER)).toBe(false);
  });

  it("keeps the folder a surviving session works in, and sweeps it once the session is gone", () => {
    const { housekeeping, ended, fakes, sessions } = setup();
    ended(TASK, "failed", "s1");
    sessions.state.mockReturnValue({ archived: false, running: false, needsInput: false });
    fakes.taskFolders.mockReturnValue(new Set([fakes.scratchPathOf(AGENT, TASK)]));
    housekeeping.pass();
    expect(bed.db.get("SELECT 1 AS n FROM tasks")).toBeUndefined();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(true);
    fakes.taskFolders.mockReturnValue(new Set());
    housekeeping.pass();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(false);
  });

  it("sweeps an orphan folder and keeps one a live task row names", () => {
    const { housekeeping, finished, fakes } = setup();
    finished(TASK, { agentId: AGENT, target: "isolated" }, "s1");
    bed.db.run("DROP TRIGGER IF EXISTS tasks_terminal_immutable");
    bed.db.run("UPDATE tasks SET state = 'running', ended_at = NULL, session_id = NULL WHERE id = $id", {
      id: TASK,
    });
    fakes.ports.registry.openScratch("u1", AGENT, TASK);
    fakes.ports.registry.openScratch("u1", AGENT, "0b1c2d3e-0009-4000-8000-000000000009");
    housekeeping.pass();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(true);
    expect(fakes.scratchExists(AGENT, "0b1c2d3e-0009-4000-8000-000000000009")).toBe(false);
  });

  it("keeps the folder a session still names even when the task row never got that session (cancelled before its commit)", () => {
    const { housekeeping, ended, fakes } = setup({ sweep: false });
    ended(TASK, "cancelled", null);
    fakes.taskFolders.mockReturnValue(new Set([fakes.scratchPathOf(AGENT, TASK)]));
    housekeeping.pass();
    expect(bed.db.get("SELECT 1 AS n FROM tasks")).toBeUndefined();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(true);
  });

  it("drops the folders of at most 100 rows a pass; the sweep takes the rest", () => {
    const { housekeeping, ended, fakes } = setup({ sweep: false });
    for (let n = 0; n < 102; n += 1)
      ended(`0b1c2d3e-${String(n).padStart(4, "0")}-4000-8000-000000000001`, "failed", null);
    housekeeping.pass();
    expect(fakes.removed).toHaveLength(100);
  });
});
