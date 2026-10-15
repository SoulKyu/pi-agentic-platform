import { afterEach, describe, expect, it } from "vitest";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

async function running(change: { max_run_usd?: number } = {}) {
  const trigger = bed.trigger();
  const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
  if (change.max_run_usd !== undefined)
    bed.db.run("UPDATE tasks SET max_run_usd = $usd WHERE id = $id", {
      id: taskId as string,
      usd: change.max_run_usd,
    });
  await bed.engine.runner.handleStart({ taskId: taskId as string }, effectContext());
  return taskId as string;
}
const row = (id: string) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = $id", { id });

describe("how a run's end settles its task (M10R38)", () => {
  it.each([
    ["completed", null, "done", null],
    ["failed", null, "failed", "provider"],
    ["cancelled", "aborted", "cancelled", "stopped"],
    ["cancelled", null, "cancelled", "stopped"],
    ["interrupted", "crash", "interrupted", "crash"],
  ] as const)("%s (%s) gives %s", async (status, errorClass, state, reason) => {
    bed = createRunnerBed();
    const id = await running();
    bed.runs.endRun({ sessionId: "s1", status, errorClass, taskId: id });
    expect(row(id)).toMatchObject({ state, reason, ended_at: bed.clock.now() });
  });

  it("makes the task limited, not over, with no end time, and remembers when the quota resets", async () => {
    bed = createRunnerBed();
    const id = await running();
    const resetAt = bed.clock.now() + 3_600_000;
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: resetAt });
    expect(row(id)).toMatchObject({ state: "limited", ended_at: null });
    const view = bed.frames.at(-2)?.event as {
      kind: string;
      task: { state: string; resetAt: number | null };
    };
    expect(view).toMatchObject({ kind: "task", task: { state: "limited", resetAt } });
  });

  it.each(["deadline", "run_budget", "budget"] as const)(
    "leaves the task as the runner set it when the run was cut by the runner (%s)",
    async (errorClass) => {
      bed = createRunnerBed();
      const id = await running();
      bed.runs.endRun({ sessionId: "s1", status: "cancelled", errorClass, taskId: id });
      expect(row(id)?.state).toBe("running");
      bed.db.run("UPDATE tasks SET state = 'failed', reason = $errorClass, ended_at = 5 WHERE id = $id", {
        id,
        errorClass,
      });
      bed.runs.endRun({ sessionId: "s1", status: "cancelled", errorClass, taskId: id });
      expect(row(id)).toMatchObject({ state: "failed", reason: errorClass });
    },
  );

  it("ignores a run that ends after the task is over", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    const events = bed.frames.length;
    bed.runs.endRun({ sessionId: "s1", status: "failed", taskId: id });
    expect(row(id)).toMatchObject({ state: "done", reason: null });
    expect(bed.frames).toHaveLength(events);
  });

  it("ignores the end of a run in a session no task owns", async () => {
    bed = createRunnerBed();
    await running();
    bed.runs.endRun({ sessionId: "somebody-else", status: "completed" });
    expect(bed.tasks().map((task) => task.state)).toEqual(["running"]);
  });

  it("emits the task event with the state it left", async () => {
    bed = createRunnerBed();
    const id = await running();
    const seen: Array<[string, string | null]> = [];
    bed.engine.events.on((event) => {
      if (event.kind === "task") seen.push([event.task.state, event.previous]);
    });
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    expect(seen).toEqual([["done", "running"]]);
  });

  it("releases the finished task's idle worker at once", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.sessions.releaseIdle.mockClear();
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    await Promise.resolve();
    expect(bed.sessions.releaseIdle).toHaveBeenCalledWith("u1", "s1");
  });

  it("does not let a failing release escape", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.sessions.releaseIdle.mockImplementationOnce(() => {
      throw new Error("gone");
    });
    expect(() => bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id })).not.toThrow();
    await bed.clock.advance(0);
    expect(bed.logs.some((line) => line.msg === "task_release_failed")).toBe(true);
  });

  it("keeps the move when the board's view of the task cannot be built, and says so", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.sessions.state.mockImplementation(() => {
      throw new Error("session gone");
    });
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    expect(row(id)?.state).toBe("done");
    expect(bed.logs.some((line) => line.msg === "task_event_failed")).toBe(true);
  });

  it("tries a busy worker's release again a little later, and stops after three tries", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.sessions.releaseIdle.mockClear();
    bed.sessions.releaseIdle.mockReturnValue("busy");
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    await bed.clock.advance(0);
    expect(bed.sessions.releaseIdle).toHaveBeenCalledTimes(1);
    await bed.clock.advance(2_000);
    expect(bed.sessions.releaseIdle).toHaveBeenCalledTimes(2);
    await bed.clock.advance(2_000);
    expect(bed.sessions.releaseIdle).toHaveBeenCalledTimes(3);
    await bed.clock.advance(10_000);
    expect(bed.sessions.releaseIdle).toHaveBeenCalledTimes(3);
  });

  it("holds no slot for a limited task, and a run starting in its session makes it running again", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.runs.endRun({
      sessionId: "s1",
      status: "limited",
      taskId: id,
      limitResetAt: bed.clock.now() + 60_000,
    });
    expect(bed.engine.counts("u1")).toMatchObject({ running: 0 });
    bed.runs.startRun("s1", id);
    expect(row(id)).toMatchObject({ state: "running", ended_at: null });
    expect(bed.engine.counts("u1")).toMatchObject({ running: 1 });
    const view = bed.frames.at(-2)?.event as { task: { resetAt: number | null } };
    expect(view.task.resetAt).toBeNull();
  });

  it("ignores a run starting in the session of a task that is not limited", async () => {
    bed = createRunnerBed();
    const id = await running();
    const events = bed.frames.length;
    bed.runs.startRun("s1", id);
    expect(row(id)?.state).toBe("running");
    expect(bed.frames).toHaveLength(events);
  });
});

describe("the task's end hook (M10R154)", () => {
  const ends = [
    ["done", (id: string) => bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id })],
    ["failed", (id: string) => bed.runs.endRun({ sessionId: "s1", status: "failed", taskId: id })],
    ["interrupted", (id: string) => bed.runs.endRun({ sessionId: "s1", status: "interrupted", taskId: id })],
    ["cancelled", (id: string) => bed.runs.endRun({ sessionId: "s1", status: "cancelled", taskId: id })],
  ] as const;

  it.each(ends)(
    "ends the policy, the expectation and the worker once at %s, and archives only done",
    async (state, end) => {
      bed = createRunnerBed();
      const id = await running();
      bed.sessions.releaseIdle.mockClear();
      bed.sessions.archive.mockClear();
      bed.runs.port.clearExpected.mockClear();
      end(id);
      await bed.clock.advance(0);
      expect(row(id)?.state).toBe(state);
      expect(bed.policy.ended).toEqual(["s1"]);
      expect(bed.runs.port.clearExpected).toHaveBeenCalledTimes(1);
      expect(bed.runs.port.clearExpected).toHaveBeenCalledWith("s1");
      expect(bed.sessions.releaseIdle).toHaveBeenCalledTimes(1);
      expect(bed.sessions.archive).toHaveBeenCalledTimes(state === "done" ? 1 : 0);
    },
  );

  it("ends the policy of a task cancelled while running, after its abort", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.order.length = 0;
    await bed.engine.runner.cancel("u1", id);
    expect(bed.policy.ended).toEqual(["s1"]);
    expect(bed.order.indexOf("abort:s1")).toBeLessThan(bed.order.indexOf("release:s1"));
    expect(bed.sessions.archive).not.toHaveBeenCalled();
  });

  it("ends the policy of a task a limit stopped, after the abort, and never archives it", async () => {
    bed = createRunnerBed();
    const id = await running({ max_run_usd: 1 });
    bed.runs.liveCost("s1", 2);
    await bed.clock.advance(0);
    expect(row(id)).toMatchObject({ state: "failed", reason: "run_budget" });
    expect(bed.policy.ended).toEqual(["s1"]);
    expect(bed.sessions.releaseIdle).toHaveBeenCalledWith("u1", "s1");
    expect(bed.sessions.archive).not.toHaveBeenCalled();
  });

  it("goes on with the other steps when one of them throws, and says so", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.policy.port.endTaskPolicy.mockImplementationOnce(() => {
      throw new Error("policy gone");
    });
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    await bed.clock.advance(0);
    expect(bed.sessions.archive).toHaveBeenCalledWith("u1", "s1");
    expect(bed.sessions.releaseIdle).toHaveBeenCalledWith("u1", "s1");
    expect(bed.logs.some((line) => line.msg === "task_end_step_failed")).toBe(true);
  });

  it("fails a limited task whose resume the runs module skipped for the budget (M10R160)", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: bed.clock.now() + 1 });
    bed.sessions.releaseIdle.mockClear();
    bed.runs.skipResume("s1", "budget");
    await bed.clock.advance(0);
    expect(row(id)).toMatchObject({ state: "failed", reason: "budget", ended_at: bed.clock.now() });
    expect(bed.policy.ended).toEqual(["s1"]);
    expect(bed.sessions.releaseIdle).toHaveBeenCalledTimes(1);
  });

  it("cancels a limited task whose resume was skipped because the session was archived (M10R160)", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: bed.clock.now() + 1 });
    bed.runs.skipResume("s1", "archived");
    expect(row(id)).toMatchObject({ state: "cancelled", reason: "archived" });
  });

  it("leaves a running task, an unknown session and any other reason alone", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.runs.skipResume("s1", "budget");
    bed.runs.skipResume("nobody", "budget");
    expect(row(id)?.state).toBe("running");
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: bed.clock.now() + 1 });
    bed.runs.skipResume("s1", "something-else");
    expect(row(id)?.state).toBe("limited");
  });
});
