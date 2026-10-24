import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT,
  fakeAgentPorts,
  type FakeAgentPorts,
  insertAgentTrigger,
  TASK,
} from "./testing/agent-fakes.ts";
import { createRunnerBed, deferred, effectContext, type RunnerBed } from "./testing/runner-bed.ts";
import { createAgentTaskLink } from "./runner-agent.ts";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

const OTHER = "0b1c2d3e-0002-4000-8000-000000000002";
const THIRD = "0b1c2d3e-0003-4000-8000-000000000003";

function setup() {
  bed = createRunnerBed();
  // The agents' folders sit inside $PAP_HOME, which `resolveFolder` refuses: the runner must not ask it for them.
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  bed.engine.agents.bind(fakes.ports);
}

function agentTask(
  over: {
    id?: string;
    tainted?: boolean;
    agentId?: string;
    target?: "isolated" | "thread";
    triggerId?: string | null;
  } = {},
): string {
  const id = over.id ?? TASK;
  bed.engine.store.insert({
    id,
    ownerId: "u1",
    triggerId: over.triggerId ?? null,
    origin: "webhook",
    cwd: fakes.homeOf(over.agentId ?? AGENT),
    prompt: "Do it",
    tainted: over.tainted ?? false,
    gated: false,
    policy: { mode: "supervised", tools: ["read", "grep"], preset: "read-only", env: [] },
    title: "Nightly",
    detail: null,
    retryOf: null,
    retryOnInterrupt: false,
    maxRunMs: 600_000,
    maxRunUsd: null,
    at: bed.clock.now(),
    agentId: over.agentId ?? AGENT,
    target: over.target ?? "isolated",
  });
  return id;
}
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const row = (id = TASK) =>
  bed.db.get<{ state: string; reason: string | null; session_id: string | null }>(
    "SELECT state, reason, session_id FROM tasks WHERE id = $id",
    { id },
  );

describe("an isolated agent task (M11R67)", () => {
  it("makes its scratch folder and starts through createAgentSession with role task, the policy and that folder", async () => {
    setup();
    agentTask();
    expect(await start()).toEqual({ outcome: "done" });
    expect(fakes.createAgentSession).toHaveBeenCalledTimes(1);
    expect(fakes.createAgentSession).toHaveBeenCalledWith({
      ownerId: "u1",
      agentId: AGENT,
      role: "task",
      task: { mode: "supervised", tools: ["read", "grep"], preset: "read-only", tainted: false },
      scratch: fakes.scratchPathOf(AGENT, TASK),
    });
    expect(fakes.scratchExists(AGENT, TASK)).toBe(true);
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
    expect(row()).toEqual({ state: "running", reason: null, session_id: "agent-s1" });
    expect(bed.sessions.prompt).toHaveBeenCalledWith({
      ownerId: "u1",
      sessionId: "agent-s1",
      text: "Do it",
      stillWanted: expect.any(Function),
    });
    expect(bed.order.filter((line) => line.startsWith("expect:") || line.startsWith("prompt:"))).toEqual([
      "expect:agent-s1",
      "prompt:agent-s1",
    ]);
  });

  it("starts tainted when the task's input was outside text", async () => {
    setup();
    agentTask({ tainted: true });
    await start();
    expect(fakes.createAgentSession.mock.calls[0]?.[0]).toMatchObject({ task: { tainted: true } });
  });

  it("does not make a session or a scratch folder for a task of the agent's thread: it prompts the thread (M11R71)", async () => {
    setup();
    agentTask({ target: "thread" });
    await start();
    expect(row()).toMatchObject({ state: "running", session_id: `thread-${AGENT}` });
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(false);
  });
});

describe("a start that cannot happen", () => {
  it("fails sandbox_unavailable, removes the empty folder it made, and writes the journal line", async () => {
    setup();
    const trigger = insertAgentTrigger(bed.db, fakes.homeOf(AGENT));
    agentTask({ triggerId: trigger });
    fakes.createAgentSession.mockRejectedValueOnce(new PapError("sandbox_unavailable"));
    await start();
    expect(row()).toMatchObject({ state: "failed", reason: "sandbox_unavailable", session_id: null });
    expect(fakes.scratchExists(AGENT, TASK)).toBe(false);
    expect(
      bed.db.all("SELECT verdict, detail, source, task_id FROM trigger_fires WHERE trigger_id = $trigger", {
        trigger,
      }),
    ).toEqual([{ verdict: "error", detail: "sandbox_unavailable", source: "webhook", task_id: TASK }]);
  });

  it("defers a paused agent's task: queued, no folder, no session, put off 30 s and not an attempt", async () => {
    setup();
    fakes.add(AGENT, "u1", { paused: true });
    agentTask();
    const settlement = await start();
    expect(settlement).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(row()).toMatchObject({ state: "queued", reason: null });
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(false);
    expect(bed.engine.starting()).toEqual([]);
    expect(bed.engine.admission.pick()).toMatchObject({ kind: "none" });
    fakes.add(AGENT, "u1", { paused: false });
    await bed.clock.advance(30_000);
    expect(await start()).toEqual({ outcome: "done" });
    expect(row()?.state).toBe("running");
  });

  it("reads the pause again after the session was made: a pause that landed meanwhile discards it and puts the task off (minor 1)", async () => {
    setup();
    agentTask();
    fakes.createAgentSession.mockImplementationOnce(async () => {
      const agent = fakes.agents.get(AGENT);
      if (agent) agent.paused = true;
      return { sessionId: "agent-s1" };
    });
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(row()).toMatchObject({ state: "queued", reason: null, session_id: null });
    expect(bed.sessions.archive).toHaveBeenCalledWith("u1", "agent-s1");
    expect(bed.policy.ended).toContain("agent-s1");
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
  });

  it("cancels a quarantined agent's task", async () => {
    setup();
    fakes.add(AGENT, "u1", { paused: true, quarantinedAt: 5 });
    agentTask();
    expect(await start()).toEqual({ outcome: "done" });
    expect(row()).toMatchObject({ state: "cancelled", reason: "quarantined", session_id: null });
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(false);
  });

  it("fails the task of an agent that is gone: not_found", async () => {
    setup();
    fakes.agents.delete(AGENT);
    agentTask();
    await start();
    expect(row()).toMatchObject({ state: "failed", reason: "not_found" });
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
  });

  it("defers on capacity as a project task does: queued, put off 30 s", async () => {
    setup();
    agentTask();
    fakes.createAgentSession.mockRejectedValueOnce(new PapError("capacity"));
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(row()?.state).toBe("queued");
  });
});

describe("a task started again reuses its folder (carry 4: the taint of the first attempt)", () => {
  it("starts tainted when the folder already holds the first attempt's files", async () => {
    setup();
    agentTask();
    const path = fakes.scratchPathOf(AGENT, TASK);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "out.txt"), "written by a tainted attempt");
    await start();
    expect(fakes.createAgentSession.mock.calls[0]?.[0]).toMatchObject({
      scratch: path,
      task: { tainted: true },
    });
    expect(row()?.state).toBe("running");
  });

  it("stays as the task said when the folder is there but empty", async () => {
    setup();
    agentTask();
    mkdirSync(fakes.scratchPathOf(AGENT, TASK), { recursive: true });
    await start();
    expect(fakes.createAgentSession.mock.calls[0]?.[0]).toMatchObject({ task: { tainted: false } });
  });

  it("keeps a reused folder when the second start fails too", async () => {
    setup();
    agentTask();
    const path = fakes.scratchPathOf(AGENT, TASK);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "out.txt"), "evidence");
    fakes.createAgentSession.mockRejectedValueOnce(new PapError("sandbox_unavailable"));
    await start();
    expect(fakes.scratchExists(AGENT, TASK)).toBe(true);
  });
});

describe("the isolated run's card (M11R69)", () => {
  const finish = async (status: "completed" | "failed", cost = 0.25) => {
    await start();
    const sessionId = row()?.session_id as string;
    bed.runs.costs.set(sessionId, cost);
    await bed.clock.advance(4_000);
    bed.runs.endRun({ sessionId, status, taskId: TASK });
  };

  it("goes to the agent when the task ends done, with the facts and the run's last words", async () => {
    setup();
    agentTask();
    await finish("completed");
    await expect.poll(() => fakes.cards.length, { timeout: 2_000 }).toBe(1);
    expect(fakes.cards[0]).toEqual({
      ownerId: "u1",
      agentId: AGENT,
      taskId: TASK,
      data: {
        title: "Nightly",
        state: "done",
        source: "webhook",
        tainted: false,
        scratch: fakes.scratchPathOf(AGENT, TASK),
        summary: "The run's last words.",
        durationMs: 4_000,
        costUsd: 0.25,
      },
    });
    expect(fakes.lastText).toHaveBeenCalledWith("u1", "agent-s1", 2_000, undefined);
  });

  it("goes to the agent when the task ends failed", async () => {
    setup();
    agentTask();
    await finish("failed", 0);
    await expect.poll(() => fakes.cards.length, { timeout: 2_000 }).toBe(1);
    expect(fakes.cards[0]?.data).toMatchObject({ state: "failed", costUsd: 0 });
  });

  it("says tainted when the session got tainted during the run, whatever the task's input was", async () => {
    setup();
    agentTask();
    const policy = bed.policy.port as { sessionPolicy: (...args: never[]) => unknown };
    const base = policy.sessionPolicy;
    policy.sessionPolicy = (...args: never[]) => ({
      ...(base(...args) as object),
      taint: { tainted: true, epoch: 1 },
    });
    await finish("completed");
    await expect.poll(() => fakes.cards.length, { timeout: 2_000 }).toBe(1);
    expect(fakes.cards[0]?.data).toMatchObject({ tainted: true });
  });

  it("still writes a card when the transcript cannot be read: an empty summary", async () => {
    setup();
    agentTask();
    fakes.lastText.mockRejectedValueOnce(new Error("no file"));
    await finish("completed");
    await expect.poll(() => fakes.cards.length, { timeout: 2_000 }).toBe(1);
    expect(fakes.cards[0]?.data).toMatchObject({ summary: null });
  });

  it("writes none when the owner cancels the task", async () => {
    setup();
    agentTask();
    await start();
    await bed.engine.runner.cancel("u1", TASK);
    await bed.clock.advance(1_000);
    expect(row()?.state).toBe("cancelled");
    expect(fakes.isolated).not.toHaveBeenCalled();
  });

  it("writes none for a project task", async () => {
    setup();
    const trigger = bed.trigger();
    bed.engine.fire(trigger.id, trigger.revision, {
      ownerId: "u1",
      source: "manual",
      payload: null,
      dedupKey: null,
      title: "t",
      detail: null,
      gated: false,
      gates: { exemptDisabled: true },
      retry: null,
    });
    await start();
    expect(bed.sessions.createTaskSession).toHaveBeenCalledTimes(1);
    bed.runs.endRun({ sessionId: "s1", status: "completed" });
    await expect.poll(() => row("task-1")?.state, { timeout: 2_000 }).toBe("done");
    await bed.clock.advance(1_000);
    expect(fakes.isolated).not.toHaveBeenCalled();
  });

  it("a failing card writer is said and never undoes the task's end", async () => {
    setup();
    agentTask();
    fakes.isolated.mockImplementationOnce(() => {
      throw new Error("db closed");
    });
    await finish("completed");
    await expect.poll(() => row()?.state, { timeout: 2_000 }).toBe("done");
    await expect
      .poll(() => bed.logs.some((line) => line.msg === "agent_card_failed"), { timeout: 2_000 })
      .toBe(true);
  });
});

describe("what delete asks of the tasks (carry 1)", () => {
  const link = () =>
    createAgentTaskLink({
      store: bed.engine.store,
      starting: bed.engine.starting,
      cancel: bed.engine.runner.cancel,
    });

  it("is busy while a task of the agent runs, and not otherwise", async () => {
    setup();
    agentTask();
    expect(link().busy("u1", AGENT)).toBe(false);
    await start();
    expect(row()?.state).toBe("running");
    expect(link().busy("u1", AGENT)).toBe(true);
    expect(link().busy("u1", "sage-0000")).toBe(false);
    expect(link().busy("u2", AGENT)).toBe(false);
  });

  it("is busy while a task of the agent is being started, before it is marked running", async () => {
    setup();
    agentTask();
    const gate = deferred<{ sessionId: string }>();
    fakes.createAgentSession.mockReturnValueOnce(gate.promise);
    const starting = start();
    await expect.poll(() => fakes.createAgentSession.mock.calls.length, { timeout: 2_000 }).toBe(1);
    expect(row()?.state).toBe("queued");
    expect(link().busy("u1", AGENT)).toBe(true);
    gate.resolve({ sessionId: "agent-s9" });
    await starting;
    expect(link().busy("u1", AGENT)).toBe(true);
  });

  it("cancels the agent's queued tasks and no others", async () => {
    setup();
    fakes.add("sage-0000");
    agentTask();
    agentTask({ id: OTHER });
    agentTask({ id: THIRD, agentId: "sage-0000" });
    await link().cancelQueuedOf("u1", AGENT);
    expect(row(TASK)).toMatchObject({ state: "cancelled", reason: "cancelled" });
    expect(row(OTHER)).toMatchObject({ state: "cancelled", reason: "cancelled" });
    expect(row(THIRD)?.state).toBe("queued");
  });
});
