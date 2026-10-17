import { afterEach, describe, expect, it } from "vitest";
import { AGENT, fakeAgentPorts, type FakeAgentPorts, TASK } from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, type RunnerBed } from "./testing/runner-bed.ts";
import { createAgentTaskLink } from "./runner-agent.ts";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

const OTHER = "0b1c2d3e-0002-4000-8000-000000000002";
const THIRD = "0b1c2d3e-0003-4000-8000-000000000003";

function setup() {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  bed.engine.agents.bind(fakes.ports);
}

function agentTask(id: string, agentId = AGENT): void {
  bed.engine.store.insert({
    id,
    ownerId: "u1",
    triggerId: null,
    origin: "webhook",
    cwd: fakes.homeOf(agentId),
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
    agentId,
    target: "isolated",
  });
}
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const row = (id: string) =>
  bed.db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM tasks WHERE id = $id", {
    id,
  });

describe("what quarantine asks of the tasks (M11R115)", () => {
  const link = () =>
    createAgentTaskLink({
      store: bed.engine.store,
      starting: bed.engine.starting,
      cancel: bed.engine.runner.cancel,
    });

  it("cancels the agent's running and queued tasks, counts them, and leaves other agents' tasks", async () => {
    setup();
    fakes.add("sage-0000");
    agentTask(TASK);
    agentTask(OTHER);
    agentTask(THIRD, "sage-0000");
    await start();
    expect(row(TASK)?.state).toBe("running");
    expect(await link().cancelAllOf("u1", AGENT)).toBe(2);
    expect(row(TASK)).toMatchObject({ state: "cancelled", reason: "cancelled" });
    expect(row(OTHER)).toMatchObject({ state: "cancelled", reason: "cancelled" });
    expect(row(THIRD)?.state).toBe("queued");
    expect(await link().cancelAllOf("u1", AGENT)).toBe(0);
  });
});
