import { afterEach, describe, expect, it } from "vitest";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

async function running(maxRunUsd: number) {
  const trigger = bed.trigger();
  const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput({}));
  const id = taskId as string;
  bed.db.run("UPDATE tasks SET max_run_usd = $value WHERE id = $id", { id, value: maxRunUsd });
  await bed.engine.runner.handleStart({ taskId: id }, effectContext());
  return id;
}
const row = (id: string) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = $id", { id });

describe("a task's cost cap counts its subagents' runs (M11R141)", () => {
  it("fails the task with run_budget when a child's run reaches the cap, then aborts the parent", async () => {
    bed = createRunnerBed();
    const id = await running(1);
    // A child's first run carries the task's id (the parent's `expectOrigin`).
    bed.runs.port.expectOrigin("child-1", { origin: "subagent", taskId: id });
    bed.order.length = 0;
    bed.runs.liveCost("child-1", 0.99);
    expect(row(id)?.state).toBe("running");
    bed.runs.liveCost("child-1", 1);
    expect(row(id)).toMatchObject({ state: "failed", reason: "run_budget" });
    await bed.clock.advance(0);
    expect(bed.order.slice(0, 2)).toEqual(["ending:s1:run_budget", "abort:s1"]);
  });

  it("adds the parent's own run and its children's together", async () => {
    bed = createRunnerBed();
    const id = await running(1);
    bed.runs.port.expectOrigin("child-1", { origin: "subagent", taskId: id });
    bed.runs.port.expectOrigin("child-2", { origin: "subagent", taskId: id });
    bed.runs.liveCost("s1", 0.4);
    bed.runs.liveCost("child-1", 0.3);
    bed.runs.liveCost("child-2", 0.2);
    expect(row(id)?.state).toBe("running");
    bed.runs.liveCost("child-2", 0.35);
    expect(row(id)).toMatchObject({ state: "failed", reason: "run_budget" });
  });

  it("does not count a run that belongs to no armed task", async () => {
    bed = createRunnerBed();
    const id = await running(1);
    bed.runs.liveCost("stranger", 50);
    expect(row(id)?.state).toBe("running");
  });
});
