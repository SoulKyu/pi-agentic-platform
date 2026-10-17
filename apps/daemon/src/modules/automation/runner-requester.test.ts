import { afterEach, describe, expect, it } from "vitest";
import { createAgentTaskLink } from "./runner-agent.ts";
import { AGENT, fakeAgentPorts, type FakeAgentPorts, TASK } from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, type RunnerBed } from "./testing/runner-bed.ts";

// W5-R64 I4: a quarantined agent's own delegations (requested_by = the agent) end, and never start in another agent.
let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed?.dispose());

const REQUESTER = "sage-0000";
const OTHER = "0b1c2d3e-0002-4000-8000-000000000002";

function setup(): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  fakes.add(REQUESTER);
  bed.engine.agents.bind(fakes.ports);
}
function delegation(id: string, target: "thread" | "isolated", requestedBy = REQUESTER, origin = "delegate") {
  bed.engine.store.insert({
    id,
    ownerId: "u1",
    triggerId: null,
    origin,
    cwd: fakes.homeOf(AGENT),
    prompt: "Check the board",
    tainted: false,
    gated: false,
    policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
    title: "Ask",
    detail: null,
    retryOf: null,
    retryOnInterrupt: false,
    maxRunMs: 600_000,
    maxRunUsd: null,
    at: bed.clock.now(),
    agentId: AGENT,
    target,
    requestedBy,
  });
}
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const row = (id: string) =>
  bed.db.get<{ state: string; reason: string | null; session_id: string | null }>(
    "SELECT state, reason, session_id FROM tasks WHERE id = $id",
    { id },
  );

describe("quarantine ends the delegations the agent requested", () => {
  const link = () =>
    createAgentTaskLink({
      store: bed.engine.store,
      starting: bed.engine.starting,
      cancel: bed.engine.runner.cancel,
    });

  it("cancels the queued ones, counts them, and leaves other requesters' and other origins' tasks", async () => {
    setup();
    delegation(TASK, "thread");
    delegation(OTHER, "thread", "scout-0000");
    expect(await link().cancelAllOf("u1", REQUESTER)).toBe(1);
    expect(row(TASK)).toMatchObject({ state: "cancelled", reason: "cancelled" });
    expect(row(OTHER)?.state).toBe("queued");
    expect(await link().cancelAllOf("u1", REQUESTER)).toBe(0);
  });
});

describe("quarantine and a delegation already running", () => {
  it("cancels it too (W5-R65)", async () => {
    setup();
    delegation(TASK, "thread");
    await start();
    expect(row(TASK)?.state).toBe("running");
    const link = createAgentTaskLink({
      store: bed.engine.store,
      starting: bed.engine.starting,
      cancel: bed.engine.runner.cancel,
    });
    expect(await link.cancelAllOf("u1", REQUESTER)).toBe(1);
    expect(row(TASK)).toMatchObject({ state: "cancelled", reason: "cancelled" });
  });
});

describe("a start refuses a delegation whose requester is quarantined", () => {
  it("cancels one aimed at a thread, with no prompt and no thread opened", async () => {
    setup();
    delegation(TASK, "thread");
    fakes.add(REQUESTER, "u1", { quarantinedAt: 5, paused: true });
    await start();
    expect(row(TASK)).toMatchObject({ state: "cancelled", reason: "quarantined" });
    expect(fakes.open).not.toHaveBeenCalled();
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
  });

  it("cancels one aimed at an isolated task, with no session made", async () => {
    setup();
    delegation(TASK, "isolated");
    fakes.add(REQUESTER, "u1", { quarantinedAt: 5, paused: true });
    expect(await start()).toEqual({ outcome: "done" });
    expect(row(TASK)).toMatchObject({ state: "cancelled", reason: "quarantined", session_id: null });
    expect(fakes.createAgentSession).not.toHaveBeenCalled();
  });

  it("runs one whose requester is only paused", async () => {
    setup();
    delegation(TASK, "thread");
    fakes.add(REQUESTER, "u1", { paused: true });
    await start();
    expect(row(TASK)?.state).toBe("running");
  });
});
