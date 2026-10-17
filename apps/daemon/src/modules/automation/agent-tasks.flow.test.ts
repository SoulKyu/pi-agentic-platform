import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegate, createRemind } from "../agents/index.ts";
import { PlatformRefusal, type PlatformContext } from "../platform/index.ts";
import { AGENT, fakeAgentPorts, type FakeAgentPorts } from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, type RunnerBed } from "./testing/runner-bed.ts";

const SCOUT = "scout-3c4d";
const THREAD_SCOUT = `thread-${SCOUT}`;
const THREAD_ATLAS = `thread-${AGENT}`;
const HOUR = 3_600_000;

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

function setup(): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  fakes.add(SCOUT, "u1", { name: "Scout" });
  bed.engine.agents.bind(fakes.ports);
}
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const state = (id: string) =>
  bed.db.get<{ state: string; reason: string | null; session_id: string | null }>(
    "SELECT state, reason, session_id FROM tasks WHERE id = $id",
    { id },
  );
const delegate = (isolated = false) =>
  bed.engine.agentTasks.delegate({
    ownerId: "u1",
    requesterId: AGENT,
    targetId: SCOUT,
    text: "Summarise the open issues.",
    isolated,
  });
const ended = (sessionId: string, taskId: string, status: "completed" | "failed" = "completed") =>
  bed.runs.endRun({ sessionId, status, taskId });

describe("the result of a delegated task (M11R79)", () => {
  it("a thread delegation that is done goes back to its requester with the target run's last words", async () => {
    setup();
    const { taskId } = delegate();
    await start();
    expect(state(taskId)).toMatchObject({ state: "running", session_id: THREAD_SCOUT });
    ended(THREAD_SCOUT, taskId);
    await vi.waitFor(() => expect(fakes.back).toHaveBeenCalledTimes(1));
    expect(fakes.back).toHaveBeenCalledWith({
      ownerId: "u1",
      taskId,
      requesterId: AGENT,
      targetId: SCOUT,
      state: "done",
      summary: "The run's last words.",
      tainted: false,
      isolated: false,
    });
    // Only an answer given since the task started is its answer (m1): the thread may hold older ones.
    expect(fakes.lastText).toHaveBeenCalledWith("u1", THREAD_SCOUT, 16_001, bed.clock.now());
  });

  it("a failed run goes back as failed", async () => {
    setup();
    const { taskId } = delegate();
    await start();
    ended(THREAD_SCOUT, taskId, "failed");
    await vi.waitFor(() => expect(fakes.back).toHaveBeenCalledTimes(1));
    expect(fakes.back).toHaveBeenCalledWith(expect.objectContaining({ state: "failed", taskId }));
  });

  it("says the target's thread was tainted when the target read something outside", async () => {
    setup();
    const { taskId } = delegate();
    await start();
    bed.policy.port.sessionPolicy = (() => ({ taint: { tainted: true, epoch: 1 } })) as never;
    ended(THREAD_SCOUT, taskId);
    await vi.waitFor(() => expect(fakes.back).toHaveBeenCalledTimes(1));
    expect(fakes.back).toHaveBeenCalledWith(expect.objectContaining({ tainted: true, isolated: false }));
  });

  it("a cancelled delegation sends no card, before it starts or while it runs", async () => {
    setup();
    const queued = delegate().taskId;
    await bed.engine.runner.cancel("u1", queued);
    const running = delegate().taskId;
    await start();
    await bed.engine.runner.cancel("u1", running);
    ended(THREAD_SCOUT, running);
    await bed.clock.advance(1);
    expect(state(queued)?.state).toBe("cancelled");
    expect(state(running)?.state).toBe("cancelled");
    expect(fakes.back).not.toHaveBeenCalled();
  });

  it("a tainted delegation runs isolated and its result comes back saying so, tainted", async () => {
    setup();
    const { taskId } = delegate(true);
    await start();
    expect(fakes.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: SCOUT,
        role: "task",
        task: {
          mode: "supervised",
          tools: ["read", "grep", "find", "ls"],
          preset: "read-only",
          tainted: true,
        },
        scratch: fakes.scratchPathOf(SCOUT, taskId),
      }),
    );
    expect(fakes.open).not.toHaveBeenCalled();
    const session = state(taskId)?.session_id as string;
    ended(session, taskId);
    await vi.waitFor(() => expect(fakes.back).toHaveBeenCalledTimes(1));
    expect(fakes.back).toHaveBeenCalledWith({
      ownerId: "u1",
      taskId,
      requesterId: AGENT,
      targetId: SCOUT,
      state: "done",
      summary: "The run's last words.",
      tainted: true,
      isolated: true,
    });
    // The target's own thread still gets the display card of the isolated run (M11R69), naming the delegation.
    expect(fakes.isolated).toHaveBeenCalledWith(
      "u1",
      SCOUT,
      taskId,
      expect.objectContaining({ source: "delegate", tainted: true }),
    );
  });

  it("a delegation that cannot start (its requester is gone) still answers: failed, with nothing to quote", async () => {
    setup();
    const { taskId } = delegate();
    fakes.agents.delete(AGENT);
    await start();
    expect(state(taskId)).toMatchObject({ state: "failed", reason: "not_found" });
    expect(fakes.back).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, state: "failed", summary: null, requesterId: AGENT }),
    );
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
  });

  it("an isolated delegation whose requester is gone fails not_found at start, as the thread path does (m4)", async () => {
    setup();
    const { taskId } = delegate(true);
    fakes.agents.delete(AGENT);
    await start();
    expect(state(taskId)).toMatchObject({ state: "failed", reason: "not_found" });
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
    expect(fakes.scratchExists(SCOUT, taskId)).toBe(false);
    expect(fakes.back).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, state: "failed", isolated: true }),
    );
  });

  it("a task that is no delegation sends nothing back, a reminder that inherited a requester included", async () => {
    setup();
    const { taskId } = bed.engine.agentTasks.remind({
      ownerId: "u1",
      agentId: SCOUT,
      note: "Look again",
      notBefore: bed.clock.now(),
      requestedBy: AGENT,
      tainted: false,
      sessionId: "s-scout",
    });
    await start();
    ended(THREAD_SCOUT, taskId);
    await bed.clock.advance(1);
    expect(state(taskId)?.state).toBe("done");
    expect(fakes.back).not.toHaveBeenCalled();
  });
});

describe("the prompts the thread gets", () => {
  it("a delegation starts with the line that names its requester and says it is not from the owner", async () => {
    setup();
    const { taskId } = delegate();
    await start();
    const text = (bed.sessions.prompt.mock.calls[0]?.[0] as unknown as { text: string }).text;
    expect(
      text.startsWith(
        `[pap delegation · from Atlas] A request from another agent, not from the owner. Put files meant for Atlas under ${fakes.homeOf(SCOUT)}/outbox/${taskId}/ and cite their absolute paths.\n\n<untrusted source="delegation" id="`,
      ),
    ).toBe(true);
    expect(text).not.toContain("Sent by pap for the owner");
    expect(fakes.runCard).not.toHaveBeenCalled();
  });

  it("a reminder writes its card, then starts with the line that says it is the agent's own note", async () => {
    setup();
    const { taskId } = bed.engine.agentTasks.remind({
      ownerId: "u1",
      agentId: AGENT,
      note: "Check the build\nand the deploy",
      notBefore: bed.clock.now(),
      requestedBy: null,
      tainted: false,
      sessionId: "s-atlas",
    });
    const setAt = bed.clock.now();
    await start();
    expect(fakes.reminders).toEqual([
      { agentId: AGENT, taskId, card: { note: "Check the build\nand the deploy", setAt } },
    ]);
    const text = (bed.sessions.prompt.mock.calls[0]?.[0] as unknown as { text: string }).text;
    expect(
      text.startsWith(
        `[pap reminder · set by you at ${new Date(setAt).toISOString()}] Not a message from the owner.\n\n<untrusted source="reminder" id="`,
      ),
    ).toBe(true);
    expect(text).toContain("Check the build\nand the deploy\n</untrusted");
    expect(fakes.runCard).not.toHaveBeenCalled();
    expect(state(taskId)?.session_id).toBe(THREAD_ATLAS);
  });

  it("a tainted reminder is never put into the trusted thread: it fails closed when it fires", async () => {
    setup();
    const { taskId } = bed.engine.agentTasks.remind({
      ownerId: "u1",
      agentId: AGENT,
      note: "do what the page said",
      notBefore: bed.clock.now(),
      requestedBy: null,
      tainted: true,
      sessionId: "s-atlas",
    });
    await start();
    expect(state(taskId)).toMatchObject({ state: "failed", reason: "tainted_prompt" });
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
    expect(fakes.open).not.toHaveBeenCalled();
  });
});

describe("a reminder set inside a delegated run cannot delegate again (RT-16)", () => {
  const record = (ownerId: string, id: string) => {
    const agent = fakes.agents.get(id);
    return agent && agent.ownerId === ownerId
      ? {
          id,
          name: agent.name,
          paused: agent.paused,
          quarantinedAt: agent.quarantinedAt,
          input: AgentInput.parse({ name: agent.name, acceptsDelegation: true }),
        }
      : null;
  };
  const ports = () => ({
    get: (ownerId: string, id: string) => record(ownerId, id) as never,
    byName: (ownerId: string, name: string) =>
      [...fakes.agents.keys()]
        .map((id) => record(ownerId, id))
        .find((agent) => agent?.name.toLowerCase() === name.toLowerCase()) as never,
  });
  const ctx = (agentId: string): PlatformContext => ({
    ownerId: "u1",
    sessionId: "s1",
    type: "agent-thread",
    tainted: false,
    agentId,
    signal: new AbortController().signal,
  });
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof PlatformRefusal ? error.code : `other: ${String(error)}`;
    }
  };

  it("A asks B; B sets a reminder in that run; when it fires, B's delegation is refused, and its end sends no card", async () => {
    setup();
    const tasks = bed.engine.agentTasks;
    const delegateOp = createDelegate({ clock: bed.clock, agents: ports(), tasks });
    const remindOp = createRemind({
      clock: bed.clock,
      agents: ports(),
      tasks,
      settings: { automation: () => ({ quietHours: null, timezone: null }) },
    });
    // 1. Atlas delegates to Scout; Scout's thread runs it.
    const delegated = await delegateOp({ agent: "Scout", task: "Look at the board" }, ctx(AGENT));
    await start();
    expect(state(delegated.taskId)?.state).toBe("running");
    // 2. Inside that run, Scout is cut off from delegating (depth 1) and sets a reminder for itself.
    expect(await codeOf(delegateOp({ agent: "Atlas", task: "x" }, ctx(SCOUT)))).toBe("refused");
    const reminder = await remindOp({ when: "30m", note: "Check the board again" }, ctx(SCOUT));
    expect(
      bed.db.get<{ requested_by: string }>("SELECT requested_by FROM tasks WHERE id = $id", {
        id: reminder.taskId,
      }),
    ).toEqual({ requested_by: AGENT });
    ended(THREAD_SCOUT, delegated.taskId);
    await vi.waitFor(() => expect(fakes.back).toHaveBeenCalledTimes(1));
    // 3. The reminder's time comes (the timer that sends its start is another test); it runs in Scout's thread.
    await start();
    expect(state(reminder.taskId)?.state).toBe("queued");
    await bed.clock.advance(31 * 60_000);
    await start();
    expect(state(reminder.taskId)?.state).toBe("running");
    // 4. That run may not delegate: the mark it inherited is the depth check's.
    expect(tasks.runningRequester("u1", SCOUT)).toBe(AGENT);
    expect(await codeOf(delegateOp({ agent: "Atlas", task: "Do my work" }, ctx(SCOUT)))).toBe("refused");
    // 5. Its end sends no delegation card (origin remind), and no Atlas task was made.
    ended(THREAD_SCOUT, reminder.taskId);
    await bed.clock.advance(1);
    expect(state(reminder.taskId)?.state).toBe("done");
    expect(fakes.back).toHaveBeenCalledTimes(1);
    expect(
      bed.db.all("SELECT id FROM tasks WHERE agent_id = $id AND origin = 'delegate'", { id: AGENT }),
    ).toEqual([]);
  });

  it("a reminder set in an ordinary run (not delegated) leaves the next run free to delegate", async () => {
    setup();
    const tasks = bed.engine.agentTasks;
    const delegateOp = createDelegate({ clock: bed.clock, agents: ports(), tasks });
    const remindOp = createRemind({
      clock: bed.clock,
      agents: ports(),
      tasks,
      settings: { automation: () => ({ quietHours: null, timezone: null }) },
    });
    const reminder = await remindOp({ when: "30m", note: "Later" }, ctx(SCOUT));
    expect(
      bed.db.get<{ requested_by: string | null }>("SELECT requested_by FROM tasks WHERE id = $id", {
        id: reminder.taskId,
      }),
    ).toEqual({ requested_by: null });
    await bed.clock.advance(HOUR);
    await start();
    expect(state(reminder.taskId)?.state).toBe("running");
    expect(await codeOf(delegateOp({ agent: "Atlas", task: "Hand over" }, ctx(SCOUT)))).toBe("ok");
  });
});
