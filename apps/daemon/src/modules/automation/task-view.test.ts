import { afterEach, describe, expect, it } from "vitest";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";
import type { TaskJoined } from "./tasks.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

describe("TaskView.waiting", () => {
  it("waiting clears when the task starts", async () => {
    let building = true;
    bed = createRunnerBed({ imageBuild: () => (building ? {} : null) });
    const trigger = bed.trigger();
    const id = bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string;
    const view = () => bed.engine.views(bed.engine.store.get(id) as unknown as TaskJoined);

    expect(view().waiting).toBeNull();
    await bed.engine.runner.handleStart({ taskId: id }, effectContext());
    expect(view().waiting).toEqual({ reason: "image_build", nextTryAt: bed.clock.now() + 10_000 });

    building = false;
    await bed.clock.advance(10_000);
    await bed.engine.runner.handleStart({ taskId: id }, effectContext());
    expect(view()).toMatchObject({ state: "running", waiting: null });
  });
});
