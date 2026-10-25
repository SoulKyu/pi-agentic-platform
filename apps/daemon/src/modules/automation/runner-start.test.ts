import { afterEach, describe, expect, it } from "vitest";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const queue = () => {
  const trigger = bed.trigger();
  return bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string;
};
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());

describe("the start path of a queued task", () => {
  it("a task on a box that builds its image defers with image_build and is not retried", async () => {
    let building: { position?: number } | null = { position: 2 };
    bed = createRunnerBed({ imageBuild: () => building });
    const id = queue();
    const events: Array<{ id: string; waiting: unknown }> = [];
    bed.engine.events.on((event) => {
      if (event.kind === "task") events.push({ id: event.task.id, waiting: event.task.waiting });
    });

    // A defer: no session is made, no attempt is spent (a retry would carry a code).
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 10_000 });
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
    expect(bed.tasks().find((task) => task.id === id)?.state).toBe("queued");
    expect(events.at(-1)).toEqual({
      id,
      waiting: { reason: "image_build", position: 2, nextTryAt: bed.clock.now() + 10_000 },
    });

    // The build is over: the same task starts, and its waiting is gone.
    building = null;
    await bed.clock.advance(10_000);
    expect(await start()).toEqual({ outcome: "done" });
    expect(bed.tasks().find((task) => task.id === id)?.state).toBe("running");
    expect(events.at(-1)?.waiting ?? null).toBeNull();
  });
});
