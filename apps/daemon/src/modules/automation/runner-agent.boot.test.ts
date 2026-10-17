import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT, fakeAgentPorts, type FakeAgentPorts, TASK } from "./testing/agent-fakes.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

// The boot recovers the tasks before the agents module binds its ports (the composition order): an end hook that runs
// then must not drop the card of an isolated task that had finished, nor the answer a delegation owes.
function finishedAgentTask(
  over: { origin?: "webhook" | "delegate"; requestedBy?: string; running?: boolean } = {},
): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  fakes.add("requester-1");
  bed.engine.store.insert({
    id: TASK,
    ownerId: "u1",
    triggerId: null,
    origin: over.origin ?? "webhook",
    cwd: fakes.homeOf(AGENT),
    prompt: "Do it",
    tainted: false,
    gated: false,
    policy: { mode: "supervised", tools: ["read", "grep"], preset: "read-only", env: [] },
    title: "Nightly",
    detail: null,
    retryOf: null,
    retryOnInterrupt: false,
    maxRunMs: 600_000,
    maxRunUsd: null,
    at: bed.clock.now(),
    agentId: AGENT,
    target: "isolated",
    ...(over.requestedBy ? { requestedBy: over.requestedBy } : {}),
  });
  if (over.running)
    bed.engine.store.move(TASK, ["queued"], "running", { sessionId: "agent-s1", startedAt: 1 });
  else bed.engine.store.move(TASK, ["queued"], "done", { sessionId: "agent-s1", endedAt: bed.clock.now() });
  bed.policy.unattended.push({ ownerId: "u1", sessionId: "agent-s1" });
}

describe("a card owed at the boot, before the agents are bound", () => {
  it("is written once the ports are bound, and only once", async () => {
    finishedAgentTask();
    const next = bed.restart();
    next.recover();
    expect(fakes.isolated).not.toHaveBeenCalled();
    next.bindAgents(fakes.ports);
    await vi.waitFor(() => expect(fakes.isolated).toHaveBeenCalledTimes(1));
    expect(fakes.cards[0]).toMatchObject({ agentId: AGENT, taskId: TASK, data: { state: "done" } });
  });

  it("carries the answer a delegation owes its requester", async () => {
    finishedAgentTask({ origin: "delegate", requestedBy: "requester-1" });
    const next = bed.restart();
    next.recover();
    expect(fakes.back).not.toHaveBeenCalled();
    next.bindAgents(fakes.ports);
    await vi.waitFor(() => expect(fakes.back).toHaveBeenCalledTimes(1));
    expect(fakes.back.mock.calls[0]?.[0]).toMatchObject({
      taskId: TASK,
      requesterId: "requester-1",
      state: "done",
    });
  });

  it("tells a requester its delegation was interrupted by the restart, once the ports are bound", async () => {
    finishedAgentTask({ origin: "delegate", requestedBy: "requester-1", running: true });
    const next = bed.restart();
    next.recover();
    next.bindAgents(fakes.ports);
    await vi.waitFor(() => expect(fakes.back).toHaveBeenCalledTimes(1));
    expect(fakes.back.mock.calls[0]?.[0]).toMatchObject({
      taskId: TASK,
      requesterId: "requester-1",
      state: "interrupted",
      summary: null,
    });
    expect(fakes.isolated).not.toHaveBeenCalled();
  });

  it("says nothing of an interrupted run that was not a delegation", async () => {
    finishedAgentTask({ running: true });
    const next = bed.restart();
    next.bindAgents(fakes.ports);
    next.recover();
    await Promise.resolve();
    expect(fakes.back).not.toHaveBeenCalled();
    expect(fakes.isolated).not.toHaveBeenCalled();
  });

  it("says so when the kept ends are full and one is dropped", () => {
    finishedAgentTask();
    const next = bed.restart();
    const row = bed.engine.store.get(TASK);
    if (!row) throw new Error("no task");
    for (let n = 0; n < 501; n += 1) next.runner.endHook(row, null, "done");
    expect(bed.logs.filter((line) => line.msg === "agent_card_dropped_unbound")).toHaveLength(1);
  });
});
