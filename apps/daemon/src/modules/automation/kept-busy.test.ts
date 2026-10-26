import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT, fakeAgentPorts, type FakeAgentPorts, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

const KEPT = "0b1c2d3e-0101-4000-8000-000000000101";
const KEPT_KEY = "0b1c2d3e010140008000000000000101";
const PLAIN = "0b1c2d3e-0202-4000-8000-000000000202";
const OTHER_AGENT = "sage-0000";

let bed: RunnerBed;
let fakes: FakeAgentPorts;
afterEach(() => bed.dispose());

function setup() {
  bed = createRunnerBed();
  fakes = fakeAgentPorts(bed.home);
  fakes.add();
  fakes.add(OTHER_AGENT);
  bed.engine.agents.bind(fakes.ports);
  insertAgentTrigger(bed.db, fakes.homeOf(AGENT), { id: KEPT, keep: true });
  insertAgentTrigger(bed.db, fakes.homeOf(AGENT), { id: PLAIN });
}
const fire = (triggerId: string): string => {
  const revision = bed.triggers.get("u1", triggerId)?.revision ?? 0;
  const result = bed.engine.fire(triggerId, revision, fireInput({ ownerId: "u1" }));
  if (result.verdict !== "fired") throw new Error(result.verdict);
  return result.taskId as string;
};
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const row = (id: string) =>
  bed.db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM tasks WHERE id = $id", {
    id,
  });
const taskOf = (call: number) =>
  (fakes.createAgentSession.mock.calls[call]?.[0] as unknown as { task: object }).task;
const busy = () => bed.logs.filter((line) => line.msg === "kept_disk_busy");

describe("a kept start refused `conflict`: the disk is still held by the previous VM", () => {
  it("is put off 30 s, not failed, logged once, and runs when the disk is free", async () => {
    setup();
    const id = fire(KEPT);
    fakes.createAgentSession.mockRejectedValueOnce(new PapError("conflict"));
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(row(id)).toEqual({ state: "queued", reason: null });
    expect(busy()).toHaveLength(1);
    // Not picked again before its time.
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(fakes.createAgentSession).toHaveBeenCalledTimes(1);
    fakes.createAgentSession.mockRejectedValueOnce(new PapError("conflict"));
    await bed.clock.advance(30_000);
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(busy()).toHaveLength(1);
    await bed.clock.advance(30_000);
    await start();
    expect(row(id)?.state).toBe("running");
    expect(fakes.createAgentSession).toHaveBeenCalledTimes(3);
    expect(taskOf(2)).toMatchObject({ keepKey: KEPT_KEY });
  });

  it("still fails a task that keeps no folder", async () => {
    setup();
    const id = fire(PLAIN);
    fakes.createAgentSession.mockRejectedValueOnce(new PapError("conflict"));
    await start();
    expect(row(id)).toEqual({ state: "failed", reason: "conflict" });
    expect(busy()).toEqual([]);
  });
});

describe("a queued kept task whose trigger changed before it starts runs on a blank disk (K-R2 amended)", () => {
  const update = (agent: object) => {
    const config = {
      name: "Agent trigger",
      source: { type: "manual" },
      execution: {
        agent,
        tools: ["read", "grep"],
        mode: "supervised",
        precheck: null,
        env: [],
        retryOnInterrupt: false,
        maxRunMinutes: 20,
        maxRunUsd: null,
        dailyBudgetUsd: null,
      },
      prompt: "Look and report: {{payload}}",
    };
    bed.db.run("UPDATE triggers SET config = $config, agent_id = $agentId WHERE id = $id", {
      config: JSON.stringify(config),
      agentId: (agent as { agentId: string }).agentId,
      id: KEPT,
    });
  };

  it("still kept: the key is sent", async () => {
    setup();
    fire(KEPT);
    await start();
    expect(taskOf(0)).toMatchObject({ keepKey: KEPT_KEY });
  });

  it.each([
    ["the trigger is deleted", () => bed.db.run("DELETE FROM triggers WHERE id = $id", { id: KEPT })],
    ["the trigger stopped keeping", () => update({ agentId: AGENT, target: "isolated" })],
    [
      "the trigger runs as another agent",
      () => update({ agentId: OTHER_AGENT, target: "isolated", keep: true }),
    ],
    ["the trigger runs in the thread", () => update({ agentId: AGENT, target: "thread" })],
  ])("%s: no key, and the rest of the snapshot applies", async (_name, change) => {
    setup();
    const id = fire(KEPT);
    change();
    await start();
    expect(row(id)?.state).toBe("running");
    const task = taskOf(0);
    expect(task).not.toHaveProperty("keepKey");
    expect(task).toMatchObject({ mode: "supervised", tools: ["read", "grep"], tainted: false });
  });
});
