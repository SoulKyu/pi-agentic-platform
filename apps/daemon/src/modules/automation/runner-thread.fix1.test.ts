import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT, fakeAgentPorts, type FakeAgentPorts, TASK } from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, type RunnerBed } from "./testing/runner-bed.ts";
import { threadPromptLine } from "./runner-thread.ts";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => {
  bed?.dispose();
  bed = undefined as never;
});

const SECOND = "0b1c2d3e-0002-4000-8000-000000000002";
const BIRCH = "birch-3c4d";
const THREAD = `thread-${AGENT}`;
const MINUTE = 60_000;

function setup(): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  bed.engine.agents.bind(fakes.ports);
}

function threadTask(
  over: { id?: string; origin?: string; maxRunMs?: number; tainted?: boolean } = {},
): string {
  const id = over.id ?? TASK;
  bed.engine.store.insert({
    id,
    ownerId: "u1",
    triggerId: null,
    origin: over.origin ?? "schedule",
    cwd: fakes.homeOf(AGENT),
    prompt: "Check the board",
    tainted: over.tainted ?? false,
    gated: false,
    policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
    title: "Morning round",
    detail: null,
    retryOf: null,
    retryOnInterrupt: false,
    maxRunMs: over.maxRunMs ?? 3_600_000,
    maxRunUsd: null,
    at: bed.clock.now(),
    agentId: AGENT,
    target: "thread",
  });
  return id;
}
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const row = (id = TASK) =>
  bed.db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM tasks WHERE id = $id", {
    id,
  });
const sent = (): string => (bed.sessions.prompt.mock.calls[0]?.[0] as unknown as { text: string }).text;

describe("I1: no question timer for a thread task (M11R169, M11R31)", () => {
  it("leaves every dialog of the agent's thread to the owner, however long it waits; the deadline still holds", async () => {
    setup();
    threadTask();
    await start();
    bed.sessions.attend(THREAD, true);
    await bed.clock.advance(30 * MINUTE);
    expect(bed.order.filter((line) => line.startsWith("answer:"))).toEqual([]);
    expect(bed.sessions.answerUnattended).not.toHaveBeenCalled();
    expect(row()?.state).toBe("running");
    await bed.clock.advance(31 * MINUTE);
    expect(row()).toEqual({ state: "failed", reason: "deadline" });
  });

  it("still denies the question of an isolated agent task after 10 minutes (the timer is the unattended task's)", async () => {
    setup();
    bed.engine.store.insert({
      id: SECOND,
      ownerId: "u1",
      triggerId: null,
      origin: "webhook",
      cwd: fakes.homeOf(AGENT),
      prompt: "Do it",
      tainted: false,
      gated: false,
      policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
      title: "Isolated",
      detail: null,
      retryOf: null,
      retryOnInterrupt: false,
      maxRunMs: 3_600_000,
      maxRunUsd: null,
      at: bed.clock.now(),
      agentId: AGENT,
      target: "isolated",
    });
    await start();
    bed.sessions.attend("agent-s1", true);
    await bed.clock.advance(10 * MINUTE);
    expect(bed.order).toContain("answer:agent-s1");
  });
});

describe("I2: the thread serves many runs, a task owns only its own", () => {
  async function limitedTask(): Promise<void> {
    threadTask();
    await start();
    bed.runs.startRun(THREAD, TASK);
    bed.runs.endRun({
      sessionId: THREAD,
      status: "limited",
      taskId: TASK,
      limitResetAt: bed.clock.now() + 1,
    });
    expect(row()?.state).toBe("limited");
  }

  it("an owner's run starting in the thread does not move a limited task back to running", async () => {
    setup();
    await limitedTask();
    bed.runs.startRun(THREAD, null, "u1", "user");
    expect(row()?.state).toBe("limited");
    bed.runs.endRun({ sessionId: THREAD, status: "completed", taskId: null });
    bed.runs.startRun(THREAD, TASK, "u1", "resume");
    expect(row()?.state).toBe("running");
  });

  it("a limited thread task whose resume was skipped is settled, so the agent's queue moves on", async () => {
    setup();
    await limitedTask();
    threadTask({ id: SECOND });
    expect(await start()).toMatchObject({ outcome: "defer", until: bed.clock.now() + 10_000 });
    bed.runs.skipResume(THREAD, "newer_input");
    expect(row()).toEqual({ state: "failed", reason: "newer_input" });
    await bed.clock.advance(10_000);
    await start();
    expect(row(SECOND)?.state).toBe("running");
  });

  it("an archived thread settles it as cancelled", async () => {
    setup();
    await limitedTask();
    bed.runs.skipResume(THREAD, "archived");
    expect(row()).toEqual({ state: "cancelled", reason: "archived" });
  });

  it("the deadline never aborts a run that is the owner's, but still ends the task", async () => {
    setup();
    threadTask({ maxRunMs: 10 * MINUTE });
    await start();
    bed.runs.startRun(THREAD, null, "u1", "user");
    bed.order.length = 0;
    await bed.clock.advance(10 * MINUTE);
    expect(row()).toEqual({ state: "failed", reason: "deadline" });
    expect(bed.sessions.abort).not.toHaveBeenCalled();
  });

  it("Cancel never aborts a run that is the owner's", async () => {
    setup();
    threadTask();
    await start();
    bed.runs.startRun(THREAD, null, "u1", "user");
    await bed.engine.runner.cancel("u1", TASK);
    expect(row()?.state).toBe("cancelled");
    expect(bed.sessions.abort).not.toHaveBeenCalled();
  });

  it("Cancel and the deadline do abort the task's own run", async () => {
    setup();
    threadTask();
    await start();
    bed.runs.startRun(THREAD, TASK);
    await bed.engine.runner.cancel("u1", TASK);
    expect(bed.sessions.abort).toHaveBeenCalledWith("u1", THREAD);
  });

  it("forgets the open run when it ends: a later Cancel aborts again", async () => {
    setup();
    threadTask();
    await start();
    bed.runs.startRun(THREAD, null, "u1", "user");
    bed.runs.endRun({ sessionId: THREAD, status: "completed", taskId: null });
    await bed.engine.runner.cancel("u1", TASK);
    expect(bed.sessions.abort).toHaveBeenCalledTimes(1);
  });
});

describe("I3: cards of tasks that ended while the agents were not bound yet", () => {
  it("are settled when the ports are bound, once, and a card that is already final is left alone", async () => {
    bed = createRunnerBed();
    fakes = fakeAgentPorts(bed.home);
    fakes.add();
    threadTask();
    threadTask({ id: SECOND, origin: "manual" });
    bed.db.run("UPDATE tasks SET state = 'running', session_id = $s, started_at = $at", {
      s: THREAD,
      at: bed.clock.now(),
    });
    fakes.runCards.push(
      { agentId: AGENT, taskId: TASK, kind: "schedule", data: { title: "Morning round", state: "running" } },
      { agentId: AGENT, taskId: SECOND, kind: "task", data: { title: "Morning round", state: "done" } },
    );
    bed.engine.recover();
    expect(fakes.runCardEnded).not.toHaveBeenCalled();
    expect(bed.db.get("SELECT state FROM tasks WHERE id = $id", { id: TASK })).toEqual({
      state: "interrupted",
    });
    bed.engine.bindAgents(fakes.ports);
    expect(fakes.runCards[0]?.data).toMatchObject({ state: "interrupted" });
    expect(fakes.runCardEnded).toHaveBeenCalledWith(
      "u1",
      AGENT,
      TASK,
      expect.objectContaining({ state: "interrupted" }),
      {
        whileRunning: true,
      },
    );
  });
});

describe("I5 (W5-R39): the first fixed line follows the origin", () => {
  it("tells a trigger task it is sent by pap for the owner (M11R71)", () => {
    expect(threadPromptLine("schedule", "Round")).toBe(
      "[pap schedule · Round] Sent by pap for the owner, not typed by them.",
    );
  });

  it("tells a reminder it was set by the agent itself, and not from the owner (M11R80)", async () => {
    setup();
    threadTask({ origin: "remind" });
    await start();
    const set = new Date(bed.clock.now()).toISOString();
    expect(sent().split("\n")[0]).toBe(`[pap reminder · set by you at ${set}] Not a message from the owner.`);
    expect(fakes.runCard).not.toHaveBeenCalled();
  });

  it("tells a delegated task it comes from another agent, never from the owner (M11R78)", async () => {
    setup();
    fakes.add(BIRCH, "u1", { name: "Birch" });
    threadTask({ origin: "delegate" });
    bed.db.run("UPDATE tasks SET requested_by = $b", { b: BIRCH });
    await start();
    const line = sent().split("\n")[0] ?? "";
    expect(line).toBe(
      `[pap delegation · from Birch] A request from another agent, not from the owner. Put files meant for Birch under ${fakes.homeOf(AGENT)}/outbox/${TASK}/ and cite their absolute paths.`,
    );
    expect(sent()).not.toContain("Sent by pap for the owner");
    expect(sent().endsWith("\n\nCheck the board")).toBe(true);
    expect(fakes.runCard).not.toHaveBeenCalled();
  });

  it("fails a delegated task whose requester is gone: no prompt that could claim the owner sent it", async () => {
    setup();
    threadTask({ origin: "delegate" });
    bed.db.run("UPDATE tasks SET requested_by = 'ghost-0000'");
    await start();
    expect(row()).toEqual({ state: "failed", reason: "not_found" });
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
  });

  it("keeps the trigger line for the owner's queued task and a retry", async () => {
    setup();
    threadTask({ origin: "manual" });
    await start();
    expect(sent().split("\n")[0]).toContain("Sent by pap for the owner");
  });
});

describe("minor 3: a tainted prompt is refused before the thread is opened", () => {
  it("opens nothing", async () => {
    setup();
    threadTask({ tainted: true });
    await start();
    expect(row()).toEqual({ state: "failed", reason: "tainted_prompt" });
    expect(fakes.open).not.toHaveBeenCalled();
  });
});

describe("N1: a task stopped before its prompt reaches the thread (fix round 2)", () => {
  /** A prompt that waits, as a cold thread's reopen does, and asks `stillWanted` at the last moment like the sessions service. */
  function coldPrompt(): { release(): Promise<string> } {
    let release: () => Promise<string> = async () => "";
    bed.sessions.prompt.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        release = async () => {
          resolve();
          return "";
        };
        queueMicrotask(() => undefined);
      });
      const wanted = (input as { stillWanted?: () => boolean }).stillWanted?.() ?? true;
      bed.order.push(wanted ? "sent" : "dropped");
      return wanted ? "started" : "handled";
    });
    return { release: () => release() };
  }

  it("hands the prompt a stillWanted that is true while the task runs and false once it is cancelled", async () => {
    setup();
    threadTask();
    const cold = coldPrompt();
    const started = start();
    await vi.waitFor(() => expect(bed.sessions.prompt).toHaveBeenCalled());
    const input = bed.sessions.prompt.mock.calls[0]?.[0] as unknown as { stillWanted: () => boolean };
    expect(input.stillWanted()).toBe(true);
    await bed.engine.runner.cancel("u1", TASK);
    expect(input.stillWanted()).toBe(false);
    await cold.release();
    await started;
    expect(bed.order).toContain("dropped");
    expect(bed.order).not.toContain("sent");
    expect(row()).toEqual({ state: "cancelled", reason: "cancelled" });
  });

  it("is false after a budget stop too, and the card stays failed", async () => {
    setup();
    threadTask({ maxRunMs: 5 * MINUTE });
    const cold = coldPrompt();
    const started = start();
    await vi.waitFor(() => expect(bed.sessions.prompt).toHaveBeenCalled());
    const input = bed.sessions.prompt.mock.calls[0]?.[0] as unknown as { stillWanted: () => boolean };
    await bed.clock.advance(5 * MINUTE);
    expect(row()).toEqual({ state: "failed", reason: "deadline" });
    expect(input.stillWanted()).toBe(false);
    await cold.release();
    await started;
    expect(bed.order).not.toContain("sent");
    expect(fakes.runCards[0]?.data).toMatchObject({ state: "failed" });
  });
});

describe("N2: an owner's open run is never tagged by a stop", () => {
  it("marks no run ending when the deadline finds the owner's run open", async () => {
    setup();
    threadTask({ maxRunMs: 5 * MINUTE });
    await start();
    bed.runs.startRun(THREAD, null, "u1", "user");
    await bed.clock.advance(5 * MINUTE);
    expect(row()?.state).toBe("failed");
    expect(bed.runs.port.markEnding).not.toHaveBeenCalled();
  });

  it("still marks the task's own run", async () => {
    setup();
    threadTask({ maxRunMs: 5 * MINUTE });
    await start();
    bed.runs.startRun(THREAD, TASK);
    await bed.clock.advance(5 * MINUTE);
    expect(bed.runs.port.markEnding).toHaveBeenCalledWith(THREAD, "deadline");
  });
});
