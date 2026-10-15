import { AutomationSettings, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueEffect } from "../../kernel/outbox/index.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const row = (id: string) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = $id", { id });
const queued = (input = fireInput()) => {
  const trigger = bed.trigger();
  const result = bed.engine.fire(trigger.id, trigger.revision, input);
  return { trigger, taskId: result.taskId as string };
};
const running = async () => {
  const made = queued();
  await bed.engine.runner.handleStart({ taskId: made.taskId }, effectContext());
  return made;
};
const codeOf = async (work: () => unknown): Promise<string> => {
  try {
    await work();
  } catch (error) {
    return error instanceof PapError ? error.code : "other";
  }
  return "none";
};

describe("Cancel (M10R40)", () => {
  it("cancels a queued task and aborts nothing", async () => {
    bed = createRunnerBed();
    const { taskId } = queued();
    expect(await bed.engine.runner.cancel("u1", taskId)).toEqual({ taskId });
    expect(row(taskId)).toMatchObject({ state: "cancelled", ended_at: bed.clock.now() });
    expect(bed.sessions.abort).not.toHaveBeenCalled();
  });

  it("commits a running task cancelled and its resume's cancel together, then aborts once, after the commit", async () => {
    bed = createRunnerBed();
    const { taskId } = await running();
    const stateAtAbort: Array<string | undefined> = [];
    bed.sessions.abort.mockImplementation(async () => {
      stateAtAbort.push(row(taskId)?.state as string | undefined);
    });
    enqueueEffect(
      bed.db,
      {
        kind: "run.resume",
        ownerId: "u1",
        payload: { sessionId: "s1", runId: "r1", resetAt: 5 },
        dedupKey: "resume:s1:r1:5",
      },
      bed.clock.now(),
    );
    const cancelled = await bed.engine.runner.cancel("u1", taskId);
    expect(cancelled).toEqual({ taskId });
    expect(stateAtAbort).toEqual(["cancelled"]);
    expect(bed.sessions.abort).toHaveBeenCalledTimes(1);
    expect(bed.sessions.abort).toHaveBeenCalledWith("u1", "s1");
    expect(bed.db.get("SELECT status FROM outbox WHERE kind = 'run.resume'")).toEqual({ status: "retired" });
  });

  it("cancels a limited task too", async () => {
    bed = createRunnerBed();
    const { taskId } = await running();
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId, limitResetAt: bed.clock.now() + 1000 });
    await bed.engine.runner.cancel("u1", taskId);
    expect(row(taskId)?.state).toBe("cancelled");
    expect(bed.sessions.abort).toHaveBeenCalledTimes(1);
  });

  it("does not let the run's end overwrite the cancellation", async () => {
    bed = createRunnerBed();
    const { taskId } = await running();
    await bed.engine.runner.cancel("u1", taskId);
    bed.runs.endRun({ sessionId: "s1", status: "failed", taskId });
    expect(row(taskId)).toMatchObject({ state: "cancelled", reason: "cancelled" });
  });

  it("answers conflict for a task that is over, not_found for an unknown one or another owner's", async () => {
    bed = createRunnerBed();
    const { taskId } = await running();
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId });
    expect(await codeOf(() => bed.engine.runner.cancel("u1", taskId))).toBe("conflict");
    expect(await codeOf(() => bed.engine.runner.cancel("u1", "nope"))).toBe("not_found");
    expect(await codeOf(() => bed.engine.runner.cancel("u2", taskId))).toBe("not_found");
    expect(row(taskId)?.state).toBe("done");
  });

  it("still cancels when the abort fails, and logs it", async () => {
    bed = createRunnerBed();
    const { taskId } = await running();
    bed.sessions.abort.mockRejectedValueOnce(new Error("worker gone"));
    await expect(bed.engine.runner.cancel("u1", taskId)).resolves.toEqual({ taskId });
    expect(row(taskId)?.state).toBe("cancelled");
    expect(bed.logs.some((line) => line.msg === "task_abort_failed")).toBe(true);
  });
});

describe("Retry (M10R41)", () => {
  async function failedTask(input = fireInput()) {
    const made = queued(input);
    bed.sessions.createTaskSession.mockRejectedValueOnce(new PapError("worker_failed"));
    await bed.engine.runner.handleStart({ taskId: made.taskId }, effectContext());
    return made;
  }

  it.each(["failed", "interrupted", "cancelled"] as const)(
    "gives a new task for a %s one, with the same prompt",
    async (state) => {
      bed = createRunnerBed();
      const { taskId } = queued(fireInput({ detail: "line one" }));
      bed.db.run("UPDATE tasks SET state = $state, ended_at = 9, tainted = 1 WHERE id = $id", {
        id: taskId,
        state,
      });
      const result = bed.engine.runner.retry("u1", taskId, { gated: false });
      const fresh = row(result.taskId);
      expect(fresh).toMatchObject({
        state: "queued",
        origin: "retry",
        retry_of: taskId,
        prompt: row(taskId)?.prompt,
        tainted: 1,
        policy: row(taskId)?.policy,
        title: row(taskId)?.title,
        detail: "line one",
        session_id: null,
      });
      expect(
        bed.db.get("SELECT source FROM trigger_fires WHERE task_id = $id", { id: result.taskId }),
      ).toEqual({
        source: "retry",
      });
      expect(bed.effects().filter((effect) => effect.status === "pending").length).toBe(2);
    },
  );

  it("makes a browser's retry ungated and a token's retry gated", async () => {
    bed = createRunnerBed();
    const { taskId } = await failedTask();
    const browser = bed.engine.runner.retry("u1", taskId, { gated: false });
    const token = bed.engine.runner.retry("u1", taskId, { gated: true });
    expect([row(browser.taskId)?.gated, row(token.taskId)?.gated]).toEqual([0, 1]);
  });

  it("answers conflict for a task that is not over, or whose trigger is gone", async () => {
    bed = createRunnerBed();
    const live = queued();
    expect(await codeOf(() => bed.engine.runner.retry("u1", live.taskId, { gated: false }))).toBe("conflict");
    bed.db.run("UPDATE tasks SET state = 'failed', ended_at = 1 WHERE id = $id", { id: live.taskId });
    bed.triggers.remove(bed.owner(), live.trigger.id);
    expect(await codeOf(() => bed.engine.runner.retry("u1", live.taskId, { gated: false }))).toBe("conflict");
    expect(await codeOf(() => bed.engine.runner.retry("u2", live.taskId, { gated: false }))).toBe(
      "not_found",
    );
  });

  it("applies the pause and the queue limit", async () => {
    bed = createRunnerBed();
    const { taskId } = await failedTask();
    bed.settings.owners.set("u1", AutomationSettings.parse({ paused: true }));
    expect(await codeOf(() => bed.engine.runner.retry("u1", taskId, { gated: false }))).toBe(
      "automation_paused",
    );
    bed.settings.owners.clear();
    for (let n = 0; n < 20; n++) bed.engine.runner.retry("u1", taskId, { gated: false });
    expect(await codeOf(() => bed.engine.runner.retry("u1", taskId, { gated: false }))).toBe("rate_limited");
  });

  it("retries a task of a disabled trigger: the owner pressing Retry is asking by hand", async () => {
    bed = createRunnerBed();
    const { taskId, trigger } = await failedTask();
    bed.triggers.setEnabled(bed.owner(), trigger.id, false);
    expect(bed.engine.runner.retry("u1", taskId, { gated: false }).taskId).toBeDefined();
  });
});
