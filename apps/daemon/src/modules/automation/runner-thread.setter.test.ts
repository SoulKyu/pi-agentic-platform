import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT, fakeAgentPorts, type FakeAgentPorts } from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, type RunnerBed } from "./testing/runner-bed.ts";

const SCOUT = "scout-3c4d";
const THREAD = `thread-${AGENT}`;
const NOT_DELIVERED = "Reminder not delivered: the thread it was set in was reset";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

function setup(threadSession: string | null = THREAD): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add(AGENT, "u1", { threadSessionId: threadSession });
  fakes.add(SCOUT, "u1", { name: "Scout" });
  bed.engine.agents.bind(fakes.ports);
}
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const state = (id: string) =>
  bed.db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM tasks WHERE id = $id", {
    id,
  });
const remind = (over: { tainted?: boolean; sessionId?: string } = {}) =>
  bed.engine.agentTasks.remind({
    ownerId: "u1",
    agentId: AGENT,
    note: "Check the build",
    notBefore: bed.clock.now(),
    requestedBy: null,
    tainted: over.tainted ?? true,
    sessionId: over.sessionId ?? THREAD,
  }).taskId;

describe("a tainted reminder fires only into the session that set it (W5-R44)", () => {
  it("runs in the same thread session, which is tainted already", async () => {
    setup();
    const id = remind();
    await start();
    expect(state(id)).toEqual({ state: "running", reason: null });
    expect(bed.sessions.prompt).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a reset, with a card that says why, and never opens the thread", async () => {
    setup(null);
    const id = remind();
    await start();
    expect(state(id)).toEqual({ state: "failed", reason: "tainted_prompt" });
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
    expect(fakes.open).not.toHaveBeenCalled();
    expect(fakes.runCard).toHaveBeenCalledWith("u1", AGENT, id, "task", {
      title: NOT_DELIVERED,
      state: "failed",
    });
  });

  it("fails closed when the thread now is another session than the setter's", async () => {
    setup("thread-new");
    const id = remind();
    await start();
    expect(state(id)).toEqual({ state: "failed", reason: "tainted_prompt" });
    expect(fakes.runCard).toHaveBeenCalledWith("u1", AGENT, id, "task", {
      title: NOT_DELIVERED,
      state: "failed",
    });
  });

  it("fails closed when the thread opened for it is not the setter's, whatever the registry said", async () => {
    setup();
    fakes.open.mockResolvedValueOnce({ sessionId: "thread-other" });
    const id = remind();
    await start();
    expect(state(id)).toEqual({ state: "failed", reason: "tainted_prompt" });
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
  });

  it("is an exception for reminders only: any other tainted thread task still fails", async () => {
    setup();
    const id = remind();
    bed.db.run("UPDATE tasks SET origin = 'manual' WHERE id = $id", { id });
    await start();
    expect(state(id)).toEqual({ state: "failed", reason: "tainted_prompt" });
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
  });

  it("leaves an untainted reminder as it was: it runs after a reset and writes no failure card", async () => {
    setup(null);
    const id = remind({ tainted: false, sessionId: "gone-session" });
    await start();
    expect(state(id)?.state).toBe("running");
    expect(fakes.runCard).not.toHaveBeenCalledWith("u1", AGENT, id, "task", expect.anything());
  });
});

describe("the delegation request's card in the target's thread (M11R71)", () => {
  const delegate = () =>
    bed.engine.agentTasks.delegate({
      ownerId: "u1",
      requesterId: AGENT,
      targetId: SCOUT,
      text: "Check the board \u202E now",
      isolated: false,
    }).taskId;
  const SCOUT_THREAD = `thread-${SCOUT}`;

  it("is written before the prompt with the cleaned request, running, tainted false, in the TARGET's thread", async () => {
    setup();
    const id = delegate();
    fakes.delegation.mockImplementationOnce(
      (...args) => (
        bed.order.push("card"),
        fakes.requestCards.push({ agentId: args[1], taskId: args[2], data: args[3] }) > 0
      ),
    );
    await start();
    expect(bed.order.filter((line) => /^(card|expect:|prompt:)/.test(line))).toEqual([
      "card",
      `expect:${SCOUT_THREAD}`,
      `prompt:${SCOUT_THREAD}`,
    ]);
    expect(fakes.delegation).toHaveBeenCalledWith("u1", SCOUT, id, {
      fromAgentId: AGENT,
      fromName: "Atlas",
      state: "running",
      summary: "Check the board  now",
      tainted: false,
      isolated: false,
    });
  });

  it("settles to done, failed or cancelled with the task", async () => {
    setup();
    const first = delegate();
    await start();
    bed.runs.endRun({ sessionId: SCOUT_THREAD, status: "completed", taskId: first });
    await vi.waitFor(() => expect(fakes.delegationEnded).toHaveBeenCalledWith("u1", SCOUT, first, "done"));
    const second = delegate();
    await start();
    bed.runs.endRun({ sessionId: SCOUT_THREAD, status: "failed", taskId: second });
    await vi.waitFor(() => expect(fakes.delegationEnded).toHaveBeenCalledWith("u1", SCOUT, second, "failed"));
    const third = delegate();
    await start();
    await bed.engine.runner.cancel("u1", third);
    expect(fakes.delegationEnded).toHaveBeenCalledWith("u1", SCOUT, third, "cancelled");
  });

  it("is not written for a reminder, and a failing card never stops the task", async () => {
    setup();
    fakes.delegation.mockImplementationOnce(() => {
      throw new Error("db busy");
    });
    const id = delegate();
    await start();
    expect(state(id)?.state).toBe("running");
    const reminder = remind({ tainted: false });
    await start();
    expect(fakes.delegation).toHaveBeenCalledTimes(1);
    expect(reminder).toBeTruthy();
  });

  it("the settle at every boot touches a request card once: the second pass moves nothing and counts nothing", async () => {
    setup();
    const id = delegate();
    await start();
    // The daemon went down with the task running; it is failed at boot, before the agents are bound.
    bed.db.run("UPDATE tasks SET state = 'failed', reason = 'crash', ended_at = 5 WHERE id = $id", { id });
    fakes.delegationEnded.mockClear();
    // Two restarts: each binds the agents and settles the cards of the tasks that ended meanwhile.
    for (let boot = 0; boot < 2; boot += 1) bed.restart().bindAgents(fakes.ports);
    expect(fakes.delegationEnded).toHaveBeenCalledWith("u1", SCOUT, id, "failed", { whileRunning: true });
    expect(fakes.requestCards[0]?.data.state).toBe("failed");
    const results = fakes.delegationEnded.mock.results.map((result) => result.value);
    expect(results).toEqual([true, false]);
  });
});
