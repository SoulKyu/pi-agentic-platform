import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT,
  fakeAgentPorts,
  type FakeAgentPorts,
  insertAgentTrigger,
  TASK,
} from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => {
  bed?.dispose();
  bed = undefined as never;
});

const SECOND = "0b1c2d3e-0002-4000-8000-000000000002";

function threadTask(id: string): void {
  bed.engine.store.insert({
    id,
    ownerId: "u1",
    triggerId: null,
    origin: "schedule",
    cwd: fakes.homeOf(AGENT),
    prompt: "Round",
    tainted: false,
    gated: false,
    policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
    title: "Round",
    detail: null,
    retryOf: null,
    retryOnInterrupt: false,
    maxRunMs: 600_000,
    maxRunUsd: null,
    at: bed.clock.now(),
    agentId: AGENT,
    target: "thread",
  });
}
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const state = (id: string) =>
  bed.db.get<{ state: string }>("SELECT state FROM tasks WHERE id = $id", { id })?.state;

function setup(): void {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  bed.engine.agents.bind(fakes.ports);
  threadTask(TASK);
  threadTask(SECOND);
}

describe("the pause and the running mark are one synchronous step (M11R75, M11R183)", () => {
  it("a pause that lands from a microtask right after the switch was read cannot land before the mark; the next admission sees it", async () => {
    setup();
    // The admission reads the switch twice: before it opens the thread (awaited) and right before the mark (not awaited).
    // The pause is queued at the second read, the last moment before the mark.
    const registry = fakes.ports.registry;
    const get = registry.get.bind(registry);
    let reads = 0;
    vi.spyOn(registry, "get").mockImplementation((ownerId, agentId) => {
      const found = get(ownerId, agentId);
      reads += 1;
      if (reads === 2) {
        queueMicrotask(() => {
          const agent = fakes.agents.get(AGENT);
          if (agent) agent.paused = true;
        });
      }
      return found;
    });
    const pausedAtMark: boolean[] = [];
    const move = bed.engine.store.move.bind(bed.engine.store);
    vi.spyOn(bed.engine.store, "move").mockImplementation((id, from, to, change) => {
      if (to === "running") pausedAtMark.push(fakes.agents.get(AGENT)?.paused === true);
      return move(id, from, to, change);
    });

    expect(await start()).toEqual({ outcome: "done" });
    expect(reads).toBe(2);
    // Admitted: marked running while the agent was not paused; the pause landed only after the step.
    expect(pausedAtMark).toEqual([false]);
    expect(state(TASK)).toBe("running");
    expect(fakes.agents.get(AGENT)?.paused).toBe(true);

    // The second admission reads the switch and puts the task off: queued, not admitted, nothing lost.
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(state(SECOND)).toBe("queued");
    expect(pausedAtMark).toEqual([false]);
    // Pause is not cancel: the running task finishes.
    bed.runs.endRun({ sessionId: `thread-${AGENT}`, status: "completed", taskId: TASK });
    expect(state(TASK)).toBe("done");
  });

  it("a pause that lands while the thread is being opened is seen at the mark: the task is put off, not started", async () => {
    setup();
    fakes.open.mockImplementationOnce(async () => {
      const agent = fakes.agents.get(AGENT);
      if (agent) agent.paused = true;
      return { sessionId: `thread-${AGENT}` };
    });
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(state(TASK)).toBe("queued");
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
    expect(fakes.runCard).not.toHaveBeenCalled();
  });

  it("resuming lets the put-off task start when its wait is over", async () => {
    setup();
    const agent = fakes.agents.get(AGENT);
    if (agent) agent.paused = true;
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    if (agent) agent.paused = false;
    await bed.clock.advance(30_000);
    expect(await start()).toEqual({ outcome: "done" });
    expect(state(TASK)).toBe("running");
  });
});

describe("a paused agent's fires (M11R75)", () => {
  const fire = (source: "schedule" | "manual" = "schedule") => {
    const trigger = bed.db.get<{ revision: number }>(
      "SELECT revision FROM triggers WHERE id = 'trg-agent-1'",
    );
    return bed.engine.fire("trg-agent-1", trigger?.revision ?? 1, fireInput({ source, gated: false }));
  };
  const journal = () =>
    bed.db.all<{ verdict: string }>(
      "SELECT verdict FROM trigger_fires WHERE trigger_id = 'trg-agent-1' ORDER BY id",
    );

  it("journal paused and make no task; a resume lets the next fire through", () => {
    setup();
    insertAgentTrigger(bed.db, fakes.homeOf(AGENT));
    const agent = fakes.agents.get(AGENT);
    if (agent) agent.paused = true;
    expect(fire()).toEqual({ verdict: "paused" });
    expect(fire("manual")).toEqual({ verdict: "paused" });
    expect(bed.db.all("SELECT 1 FROM tasks WHERE trigger_id = 'trg-agent-1'")).toEqual([]);
    if (agent) agent.paused = false;
    expect(fire().verdict).toBe("fired");
    expect(journal().map((line) => line.verdict)).toEqual(["paused", "paused", "fired"]);
  });

  it("do the same for a quarantined agent, which is paused for good", () => {
    setup();
    insertAgentTrigger(bed.db, fakes.homeOf(AGENT));
    fakes.add(AGENT, "u1", { paused: true, quarantinedAt: 5 });
    expect(fire()).toEqual({ verdict: "paused" });
  });

  it("leave a project trigger alone", () => {
    setup();
    const trigger = bed.trigger();
    const agent = fakes.agents.get(AGENT);
    if (agent) agent.paused = true;
    expect(bed.engine.fire(trigger.id, trigger.revision, fireInput({ gated: false })).verdict).toBe("fired");
  });
});
