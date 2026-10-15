import { afterEach, describe, expect, it } from "vitest";
import { parsedInput } from "./testing/bed.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const row = (id: string) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = $id", { id });
const fired = (retryOnInterrupt = false) => {
  const trigger = bed.trigger(
    parsedInput({
      name: "Nightly check",
      source: { type: "manual" },
      execution: { cwd: bed.folder, retryOnInterrupt },
      prompt: "Look at the repository and report.",
    }),
  );
  // Enabled: the boot's retry respects a switch-off.
  bed.triggers.setEnabled(bed.owner(), trigger.id, true);
  const revision = bed.triggers.get("u1", trigger.id)?.revision ?? 0;
  const result = bed.engine.fire(trigger.id, revision, fireInput());
  return { trigger, taskId: result.taskId as string };
};
const started = async (retryOnInterrupt = false) => {
  const made = fired(retryOnInterrupt);
  await bed.engine.runner.handleStart({ taskId: made.taskId }, effectContext());
  // The outbox settled the effect that started it.
  bed.db.run("UPDATE outbox SET status = 'done', settled_at = 1");
  return made;
};

describe("the boot recovery (M10R42)", () => {
  it("makes a running task interrupted with its event, and logs one warning with the counts", async () => {
    bed = createRunnerBed();
    const { taskId } = await started();
    const seen: Array<[string, string | null]> = [];
    const next = bed.restart();
    next.events.on((event) => {
      if (event.kind === "task") seen.push([event.task.state, event.previous]);
    });
    const report = next.recover();
    expect(row(taskId)).toMatchObject({ state: "interrupted", reason: "crash", ended_at: bed.clock.now() });
    expect(seen).toEqual([["interrupted", "running"]]);
    expect(report).toMatchObject({ interrupted: 1, orphans: 0, retried: 0, requeued: 0 });
    expect(bed.logs.filter((line) => line.msg === "automation_boot_recovered")).toHaveLength(1);
  });

  it("leaves a limited task alone", async () => {
    bed = createRunnerBed();
    const { taskId } = await started();
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId, limitResetAt: bed.clock.now() + 1000 });
    bed.restart().recover();
    expect(row(taskId)?.state).toBe("limited");
  });

  it("ends the policy of an orphan task session and archives it; a session some task owns is left to the end hook", async () => {
    bed = createRunnerBed();
    const { taskId } = await started();
    bed.policy.unattended.push({ ownerId: "u1", sessionId: "s1" }, { ownerId: "u1", sessionId: "orphan-1" });
    const report = bed.restart().recover();
    expect(report.orphans).toBe(1);
    // The interrupted task's session goes through the end hook; the orphan through the sweep.
    expect(bed.policy.ended).toEqual(["s1", "orphan-1"]);
    expect(bed.sessions.archive).toHaveBeenCalledWith("u1", "orphan-1");
    expect(bed.sessions.archive).not.toHaveBeenCalledWith("u1", "s1");
    expect(row(taskId)?.state).toBe("interrupted");
  });

  it("goes on with the other orphans when one cannot be archived", async () => {
    bed = createRunnerBed();
    bed.policy.unattended.push({ ownerId: "u1", sessionId: "a" }, { ownerId: "u1", sessionId: "b" });
    bed.sessions.archive.mockImplementationOnce(() => {
      throw new Error("gone");
    });
    bed.restart().recover();
    expect(bed.sessions.archive).toHaveBeenCalledTimes(2);
  });

  it("retries an interrupted task once when its trigger asks for it, gated, and never a retry of a retry", async () => {
    bed = createRunnerBed();
    const { taskId } = await started(true);
    const report = bed.restart().recover();
    expect(report.retried).toBe(1);
    const retry = bed.tasks().find((task) => task.id !== taskId);
    expect(retry).toBeDefined();
    expect(row(retry?.id as string)).toMatchObject({
      state: "queued",
      origin: "retry",
      retry_of: taskId,
      gated: 1,
    });
    // The retry itself is cut short by a second crash: it is not retried again.
    bed.db.run(
      "UPDATE tasks SET state = 'running', ended_at = NULL, started_at = 1, session_id = 'sx' WHERE id = $id",
      {
        id: retry?.id as string,
      },
    );
    const again = bed.restart().recover();
    expect(again.retried).toBe(0);
    expect(bed.tasks()).toHaveLength(2);
  });

  it("does not retry a task whose trigger was switched off", async () => {
    bed = createRunnerBed();
    const { trigger } = await started(true);
    bed.triggers.setEnabled(bed.owner(), trigger.id, false);
    expect(bed.restart().recover().retried).toBe(0);
  });

  it("does not retry when the trigger does not ask", async () => {
    bed = createRunnerBed();
    await started(false);
    expect(bed.restart().recover().retried).toBe(0);
    expect(bed.tasks()).toHaveLength(1);
  });

  it("gives a queued task with no pending task.start one, and a task with its effect gets no second", async () => {
    bed = createRunnerBed();
    const first = fired();
    fired();
    bed.db.run("UPDATE outbox SET status = 'retired', settled_at = 1 WHERE payload = $payload", {
      payload: JSON.stringify({ taskId: first.taskId }),
    });
    const report = bed.restart().recover();
    expect(report.requeued).toBe(1);
    const live = bed.effects().filter((effect) => effect.status === "pending");
    expect(live).toHaveLength(2);
    expect(bed.restart().recover().requeued).toBe(0);
  });

  it("counts a running task's boot-time retry among the queued tasks that have an effect", async () => {
    bed = createRunnerBed();
    await started(true);
    bed.restart().recover();
    expect(bed.effects().filter((effect) => effect.status === "pending")).toHaveLength(1);
  });

  it("changes nothing and arms no timer in read-only mode", async () => {
    bed = createRunnerBed();
    const { taskId } = await started(true);
    bed.policy.unattended.push({ ownerId: "u1", sessionId: "orphan-1" });
    const report = bed.restart({ readOnly: true }).recover();
    expect(report).toEqual({ interrupted: 0, orphans: 0, retried: 0, requeued: 0 });
    expect(row(taskId)?.state).toBe("running");
    expect(bed.policy.ended).toEqual([]);
    // The old engine's deadline timer went with it, and the read-only one arms none.
    expect(bed.clock.pending()).toBe(0);
  });
});

describe("the boot ends the policy of every finished task (m11)", () => {
  it("ends the policy of an interrupted task through the end hook, and releases its worker once", async () => {
    bed = createRunnerBed();
    const { taskId } = await started();
    bed.policy.unattended.push({ ownerId: "u1", sessionId: "s1" });
    const next = bed.restart();
    bed.sessions.releaseIdle.mockClear();
    next.recover();
    await bed.clock.advance(0);
    expect(row(taskId)?.state).toBe("interrupted");
    expect(bed.policy.ended).toEqual(["s1"]);
    expect(bed.sessions.releaseIdle).toHaveBeenCalledTimes(1);
    expect(bed.sessions.archive).not.toHaveBeenCalled();
  });

  it("ends the policy of a task that finished before the crash and kept unattended, and archives a done one", async () => {
    bed = createRunnerBed();
    const done = await started();
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: done.taskId });
    const failed = await started();
    bed.runs.endRun({ sessionId: "s2", status: "failed", taskId: failed.taskId });
    // The crash fell between the move and the end hook: both sessions are still unattended.
    bed.policy.ended.length = 0;
    bed.policy.unattended.push({ ownerId: "u1", sessionId: "s1" }, { ownerId: "u1", sessionId: "s2" });
    bed.sessions.archive.mockClear();
    bed.restart().recover();
    expect(bed.policy.ended.sort()).toEqual(["s1", "s2"]);
    expect(bed.sessions.archive.mock.calls).toEqual([["u1", "s1"]]);
  });

  it("does not touch a session whose task is still queued or limited", async () => {
    bed = createRunnerBed();
    const { taskId } = await started();
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId, limitResetAt: bed.clock.now() + 1 });
    bed.policy.unattended.push({ ownerId: "u1", sessionId: "s1" });
    bed.restart().recover();
    expect(row(taskId)?.state).toBe("limited");
    expect(bed.policy.ended).toEqual([]);
  });
});
