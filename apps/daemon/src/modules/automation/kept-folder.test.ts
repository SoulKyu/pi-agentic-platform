import { afterEach, describe, expect, it } from "vitest";
import { AGENT, fakeAgentPorts, type FakeAgentPorts, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { createAutomationBed, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, deferred, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";
import { createAgentBinding } from "./trigger-agent.ts";

const KEPT = "0b1c2d3e-0101-4000-8000-000000000101";
const KEPT_KEY = "0b1c2d3e010140008000000000000101";
const PLAIN = "0b1c2d3e-0202-4000-8000-000000000202";
const KEPT_OTHER = "0b1c2d3e-0303-4000-8000-000000000303";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

function setup() {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  bed.engine.agents.bind(fakes.ports);
  insertAgentTrigger(bed.db, fakes.homeOf(AGENT), { id: KEPT, keep: true });
  insertAgentTrigger(bed.db, fakes.homeOf(AGENT), { id: PLAIN });
  insertAgentTrigger(bed.db, fakes.homeOf(AGENT), { id: KEPT_OTHER, keep: true });
}
const fire = (triggerId: string): string => {
  const revision = bed.triggers.get("u1", triggerId)?.revision ?? 0;
  const result = bed.engine.fire(triggerId, revision, fireInput({ ownerId: "u1" }));
  if (result.verdict !== "fired") throw new Error(result.verdict);
  return result.taskId as string;
};
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const state = (id: string) => bed.tasks().find((task) => task.id === id)?.state;
const policyOf = (id: string) =>
  JSON.parse(bed.db.get<{ policy: string }>("SELECT policy FROM tasks WHERE id = $id", { id })?.policy ?? "");

describe("the snapshot (K-R2)", () => {
  it("carries keep for a kept trigger and nothing for another", () => {
    setup();
    expect(policyOf(fire(KEPT)).keep).toBe(true);
    expect(policyOf(fire(PLAIN))).not.toHaveProperty("keep");
  });
});

describe("a kept run's session (K-R3)", () => {
  it("gets the trigger id without dashes as its key and starts tainted, whatever its source", async () => {
    setup();
    fire(KEPT);
    await start();
    expect(fakes.createAgentSession.mock.calls[0]?.[0]).toMatchObject({
      task: { keepKey: KEPT_KEY, tainted: true },
    });
  });

  it("gets no key and today's taint without the flag", async () => {
    setup();
    fire(PLAIN);
    await start();
    const { task } = fakes.createAgentSession.mock.calls[0]?.[0] as unknown as { task: object };
    expect(task).not.toHaveProperty("keepKey");
    expect(task).toMatchObject({ tainted: false });
  });
});

describe("one run at a time per kept trigger", () => {
  it("holds the second run while the first runs, with no attempt, and starts it after the first ends", async () => {
    setup();
    const [first, second] = [fire(KEPT), fire(KEPT)] as [string, string];
    await start();
    expect(state(first)).toBe("running");
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(state(second)).toBe("queued");
    expect(fakes.createAgentSession).toHaveBeenCalledTimes(1);
    bed.runs.endRun({ sessionId: "agent-s1", status: "completed", taskId: first });
    expect(await start()).toEqual({ outcome: "done" });
    expect(state(second)).toBe("running");
  });

  it("holds it while the first is still starting", async () => {
    setup();
    const [first, second] = [fire(KEPT), fire(KEPT)] as [string, string];
    const gate = deferred<{ sessionId: string }>();
    fakes.createAgentSession.mockImplementationOnce(() => gate.promise);
    const pending = start();
    await Promise.resolve();
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(fakes.createAgentSession).toHaveBeenCalledTimes(1);
    gate.resolve({ sessionId: "agent-slow" });
    await pending;
    expect([state(first), state(second)]).toEqual(["running", "queued"]);
  });

  it("does not hold another kept trigger's task: each has a folder of its own", async () => {
    setup();
    fire(KEPT);
    const other = fire(KEPT_OTHER);
    await start();
    await start();
    expect(state(other)).toBe("running");
    expect(
      fakes.createAgentSession.mock.calls.map(
        (call) => (call[0] as unknown as { task: { keepKey: string } }).task.keepKey,
      ),
    ).toEqual([KEPT_KEY, "0b1c2d3e030340008000000000000303"]);
  });

  it("does not hold the tasks of another trigger: they go first", async () => {
    setup();
    const [first] = [fire(KEPT), fire(KEPT)] as [string, string];
    const other = fire(PLAIN);
    await start();
    expect(state(first)).toBe("running");
    await start();
    expect(state(other)).toBe("running");
    expect(fakes.createAgentSession).toHaveBeenCalledTimes(2);
  });
});

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
const dropTrigger = (id: string) => bed.db.run("DELETE FROM triggers WHERE id = $id", { id });

describe("the end of a kept task forgets a folder its trigger lost (I1)", () => {
  it("a trigger deleted during the run: forgotten when the run ends, not before", async () => {
    setup();
    const task = fire(KEPT);
    await start();
    dropTrigger(KEPT);
    expect(fakes.forgetKept).not.toHaveBeenCalled();
    bed.runs.endRun({ sessionId: "agent-s1", status: "completed", taskId: task });
    await flush();
    expect(fakes.forgetKept.mock.calls).toEqual([["u1", AGENT, KEPT]]);
  });

  it("a start in flight when the trigger is deleted: forgotten at its end", async () => {
    setup();
    const task = fire(KEPT);
    const gate = deferred<{ sessionId: string }>();
    fakes.createAgentSession.mockImplementationOnce(() => gate.promise);
    const pending = start();
    await Promise.resolve();
    dropTrigger(KEPT);
    gate.resolve({ sessionId: "agent-slow" });
    await pending;
    expect(fakes.forgetKept).not.toHaveBeenCalled();
    bed.runs.endRun({ sessionId: "agent-slow", status: "completed", taskId: task });
    await flush();
    expect(fakes.forgetKept.mock.calls).toEqual([["u1", AGENT, KEPT]]);
  });

  it("a trigger that still keeps the agent's folder, or a plain task: nothing is forgotten", async () => {
    setup();
    const kept = fire(KEPT);
    const plain = fire(PLAIN);
    await start();
    await start();
    bed.runs.endRun({ sessionId: "agent-s1", status: "completed", taskId: kept });
    await flush();
    dropTrigger(PLAIN);
    bed.runs.endRun({ sessionId: "agent-s2", status: "completed", taskId: plain });
    await flush();
    expect(fakes.forgetKept).not.toHaveBeenCalled();
  });
});

describe("the kept key of a relaunched task session (I2)", () => {
  it("is the trigger's while its task runs or waits for a quota, and the trigger keeps the folder", async () => {
    setup();
    const task = fire(KEPT);
    await start();
    expect(bed.engine.keptKeyOf("u1", "agent-s1")).toBe(KEPT_KEY);
    expect(bed.engine.keptKeyOf("u2", "agent-s1")).toBeNull();
    bed.db.run("UPDATE tasks SET state = 'limited' WHERE id = $id", { id: task });
    expect(bed.engine.keptKeyOf("u1", "agent-s1")).toBe(KEPT_KEY);
  });

  it("is none for a plain task, a finished task or an unknown session", async () => {
    setup();
    const kept = fire(KEPT);
    fire(PLAIN);
    await start();
    await start();
    expect(bed.engine.keptKeyOf("u1", "agent-s2")).toBeNull();
    expect(bed.engine.keptKeyOf("u1", "nobody")).toBeNull();
    bed.runs.endRun({ sessionId: "agent-s1", status: "completed", taskId: kept });
    expect(bed.engine.keptKeyOf("u1", "agent-s1")).toBeNull();
  });

  it("is none once its trigger is gone, stopped keeping or keeps another agent", async () => {
    setup();
    fire(KEPT);
    await start();
    const config = bed.db.get<{ config: string }>("SELECT config FROM triggers WHERE id = $id", { id: KEPT });
    const parsed = JSON.parse(config?.config ?? "") as { execution: { agent: Record<string, unknown> } };
    const edit = (agent: Record<string, unknown>) =>
      bed.db.run("UPDATE triggers SET config = $config WHERE id = $id", {
        id: KEPT,
        config: JSON.stringify({ ...parsed, execution: { ...parsed.execution, agent } }),
      });
    edit({ ...parsed.execution.agent, keep: false });
    expect(bed.engine.keptKeyOf("u1", "agent-s1")).toBeNull();
    edit({ ...parsed.execution.agent, target: "thread", keep: false });
    expect(bed.engine.keptKeyOf("u1", "agent-s1")).toBeNull();
    dropTrigger(KEPT);
    expect(bed.engine.keptKeyOf("u1", "agent-s1")).toBeNull();
  });
});

describe("forgetting the kept folder", () => {
  const input = (over: { agentId?: string; target?: "isolated" | "thread"; keep?: boolean } = {}) =>
    parsedInput({
      name: "Pulse",
      source: { type: "manual" },
      execution: {
        agent: {
          agentId: over.agentId ?? AGENT,
          target: over.target ?? "isolated",
          ...(over.keep === false ? {} : { keep: true }),
        },
      },
      prompt: "Look and report.",
    });
  function create(agentInput = input()) {
    const binding = createAgentBinding();
    const auto = createAutomationBed({ agents: binding });
    let disposed = false;
    bed = {
      dispose: () => {
        if (!disposed) auto.dispose();
        disposed = true;
      },
    } as RunnerBed;
    fakes = fakeAgentPorts(auto.dir);
    fakes.add();
    fakes.add("sage-0000");
    binding.bind(fakes.ports);
    const { trigger } = auto.triggers.create(auto.owner(), agentInput);
    return { auto, trigger };
  }
  const key = (id: string) => id.replaceAll("-", "");

  it("deleting a kept trigger forgets it once, for its agent", () => {
    const { auto, trigger } = create();
    auto.triggers.remove(auto.owner(), trigger.id);
    expect(fakes.forgetKept.mock.calls).toEqual([["u1", AGENT, trigger.id]]);
    expect(key(trigger.id)).toHaveLength(32);
  });

  it("turning keep off forgets it; so do a new agent and a thread target", () => {
    for (const next of [
      input({ keep: false }),
      input({ agentId: "sage-0000" }),
      input({ target: "thread", keep: false }),
    ]) {
      const { auto, trigger } = create();
      auto.triggers.update(auto.owner(), {
        triggerId: trigger.id,
        baseRevision: trigger.revision,
        input: next,
      });
      expect(fakes.forgetKept.mock.calls).toEqual([["u1", AGENT, trigger.id]]);
      bed.dispose();
    }
  });

  it("a plain update, a trigger that never kept and a failing forget do not matter", async () => {
    const { auto, trigger } = create();
    auto.triggers.update(auto.owner(), {
      triggerId: trigger.id,
      baseRevision: trigger.revision,
      input: { ...input(), name: "Renamed" },
    });
    expect(fakes.forgetKept).not.toHaveBeenCalled();
    fakes.forgetKept.mockRejectedValueOnce(new Error("vmd down"));
    expect(() => auto.triggers.remove(auto.owner(), trigger.id)).not.toThrow();
    await Promise.resolve();
    bed.dispose();
    const second = create(input({ keep: false }));
    fakes.forgetKept.mockClear();
    second.auto.triggers.remove(second.auto.owner(), second.trigger.id);
    expect(fakes.forgetKept).not.toHaveBeenCalled();
  });
});
