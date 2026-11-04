import { afterEach, describe, expect, it } from "vitest";
import { createTaskReads } from "./task-reads.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

describe("task reads: activeTasks (Overview)", () => {
  it("lists the owner's live tasks as board views and nobody else's", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const id = bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string;
    await bed.engine.runner.handleStart({ taskId: id }, effectContext());
    const reads = createTaskReads({ ...bed.engine, clock: bed.clock });
    const mine = reads.activeTasks("u1");
    expect(mine.map((view) => [view.id, view.state])).toEqual([[id, "running"]]);
    expect(reads.activeTasks("u2")).toEqual([]);
  });

  it("keeps a task that ended within the board's window and drops an older one", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const id = bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string;
    await bed.engine.runner.handleStart({ taskId: id }, effectContext());
    await bed.engine.runner.cancel("u1", id);
    const reads = createTaskReads({ ...bed.engine, clock: bed.clock });
    expect(reads.activeTasks("u1").map((view) => view.state)).toEqual(["cancelled"]);
    await bed.clock.advance(86_400_000 + 1000);
    expect(reads.activeTasks("u1")).toEqual([]);
  });
});
