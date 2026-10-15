import { AutomationSettings, PapError, TASKS_LIMITS, TasksStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueEffect } from "../../kernel/outbox/index.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

type Snapshot = Extract<TasksStreamEvent, { kind: "snapshot" }>;
const snapshot = (ownerId = "u1"): Snapshot => {
  const event = TasksStreamEvent.parse(bed.engine.stream.snapshot(ownerId));
  if (event.kind !== "snapshot") throw new Error("not a snapshot");
  return event;
};
const events = () => bed.frames.slice(1).map((frame) => frame.event as { kind: string });
const seed = (id: string, fields: Record<string, string | number | null> = {}, ownerId = "u1") => {
  const row = {
    id,
    owner_id: ownerId,
    origin: "manual",
    state: "done",
    cwd: "/x",
    prompt: "p",
    tainted: 0,
    gated: 1,
    policy: '{"mode":"supervised","tools":["read"],"preset":"read-only","env":[]}',
    title: `Task ${id}`,
    max_run_ms: 60_000,
    created_at: bed.clock.now(),
    ended_at: bed.clock.now(),
    ...fields,
  };
  const names = Object.keys(row);
  bed.db.run(
    `INSERT INTO tasks (${names.join(", ")}) VALUES (${names.map((name) => `$${name}`).join(", ")})`,
    row,
  );
};

describe("the tasks snapshot (M10R43)", () => {
  it("holds every non-terminal task and the terminal ones of the last 24 hours, newest first", () => {
    bed = createRunnerBed();
    const day = TASKS_LIMITS.windowMs;
    seed("old-done", { created_at: bed.clock.now() - 2 * day, ended_at: bed.clock.now() - 2 * day });
    seed("old-queued", { state: "queued", ended_at: null, created_at: bed.clock.now() - 3 * day });
    seed("recent-done", { created_at: bed.clock.now() - 1000, ended_at: bed.clock.now() - 500 });
    seed("new-running", { state: "running", ended_at: null, started_at: 1, created_at: bed.clock.now() });
    const { tasks, truncated } = snapshot();
    expect(tasks.map((task) => task.id)).toEqual(["new-running", "recent-done", "old-queued"]);
    expect(truncated).toBe(false);
  });

  it("is cut at 300 tasks and says so", () => {
    bed = createRunnerBed();
    for (let n = 0; n < TASKS_LIMITS.snapshotTasks + 5; n++)
      seed(`t${n}`, { created_at: bed.clock.now() - n });
    const { tasks, truncated } = snapshot();
    expect(tasks).toHaveLength(TASKS_LIMITS.snapshotTasks);
    expect(truncated).toBe(true);
    expect(tasks[0]?.id).toBe("t0");
  });

  it("never shows another owner's tasks or failures, and shows the system's failures to both", () => {
    bed = createRunnerBed();
    seed("mine");
    seed("theirs", {}, "u2");
    const failed = (owner: string | null, error: string) =>
      bed.db.run(
        `INSERT INTO outbox (kind, replay, owner_id, payload, status, next_at, created_at, settled_at, last_error)
         VALUES ('task.start', 'process-bound', $owner, '{"taskId":"x"}', 'failed', 0, 1, $at, $error)`,
        { owner, at: bed.clock.now(), error },
      );
    failed("u1", "mine");
    failed("u2", "theirs");
    failed(null, "system");
    expect(snapshot("u1").tasks.map((task) => task.id)).toEqual(["mine"]);
    expect(snapshot("u2").tasks.map((task) => task.id)).toEqual(["theirs"]);
    expect(
      snapshot("u1")
        .failures.map((failure) => failure.lastError)
        .sort(),
    ).toEqual(["mine", "system"]);
    expect(
      snapshot("u2")
        .failures.map((failure) => failure.lastError)
        .sort(),
    ).toEqual(["system", "theirs"]);
  });

  it("lists the owner's triggers without their config", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.trigger(undefined, bed.other());
    const { triggers } = snapshot();
    expect(triggers).toEqual([
      {
        id: trigger.id,
        name: "Nightly check",
        enabled: false,
        sourceType: "manual",
        projectId: trigger.projectId,
        state: "ok",
        nextFireAt: null,
      },
    ]);
  });

  it("carries the counts, the pause, the slots, today's spend and the budget", async () => {
    bed = createRunnerBed();
    bed.settings.value = AutomationSettings.parse({ slots: 3, paused: true, dailyBudgetUsd: 7.5 });
    seed("q1", { state: "queued", ended_at: null });
    seed("r1", { state: "running", ended_at: null, started_at: 1 });
    seed("l1", { state: "limited", ended_at: null, started_at: 1 });
    const view = snapshot();
    expect(view).toMatchObject({
      paused: true,
      slots: 3,
      running: 1,
      queued: 1,
      budgetUsd: 7.5,
      todayUsd: 0,
      quietHours: false,
    });
  });

  it("says whether quiet hours are on now", () => {
    bed = createRunnerBed();
    bed.settings.value = AutomationSettings.parse({
      timezone: "UTC",
      quietHours: { from: "00:00", to: "23:59" },
    });
    expect(snapshot().quietHours).toBe(true);
  });

  it("shows a task's live fields: a question waiting, the cost so far, the released tool list", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
    await bed.engine.runner.handleStart({ taskId: taskId as string }, effectContext());
    bed.sessions.state.mockReturnValue({ archived: false, running: true, needsInput: true });
    bed.runs.costs.set("s1", 0.25);
    expect(snapshot().tasks[0]).toMatchObject({
      id: taskId,
      state: "running",
      sessionId: "s1",
      needsInput: true,
      costUsd: 0.25,
      toolsReleased: false,
      triggerName: "Nightly check",
      triggerId: trigger.id,
      projectId: trigger.projectId,
    });
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: taskId as string });
    bed.policy.released.add("s1");
    expect(snapshot().tasks[0]).toMatchObject({ state: "done", toolsReleased: true });
  });

  it("uses the title for a task whose trigger is gone", () => {
    bed = createRunnerBed();
    seed("orphan", { title: "Left behind" });
    expect(snapshot().tasks[0]).toMatchObject({
      triggerId: null,
      triggerName: "Left behind",
      projectId: null,
    });
  });

  it("shows the first line of the payload clipped to 120 code points, without controls or format characters", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const hostile = `\u202Ealert\u0000 \u200Bfiring ${"😀".repeat(200)}\nsecond line`;
    bed.engine.fire(trigger.id, trigger.revision, fireInput({ detail: hostile }));
    const detail = snapshot().tasks[0]?.detail ?? "";
    expect([...detail]).toHaveLength(TASKS_LIMITS.detailChars);
    expect(detail.startsWith("alert firing ")).toBe(true);
    expect(detail).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(detail).not.toContain("second");
  });

  it("clips a detail stored by an older build again when it shows it", () => {
    bed = createRunnerBed();
    seed("long", { detail: `a\u202Eb${"x".repeat(300)}` });
    const detail = snapshot().tasks[0]?.detail ?? "";
    expect(detail).not.toContain("\u202E");
    expect([...detail].length).toBeLessThanOrEqual(TASKS_LIMITS.detailChars);
  });
});

describe("the tasks events", () => {
  it("sends a task event and the counts for each transition", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
    await bed.engine.runner.handleStart({ taskId: taskId as string }, effectContext());
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: taskId as string });
    const seen = events().map((event) =>
      event.kind === "task"
        ? `task:${(event as unknown as { task: { state: string } }).task.state}`
        : event.kind,
    );
    expect(seen).toEqual([
      "trigger",
      "task:queued",
      "counts",
      "task:running",
      "counts",
      "task:done",
      "counts",
    ]);
    for (const event of events()) expect(TasksStreamEvent.safeParse(event).success).toBe(true);
    expect(events().at(-1)).toMatchObject({ kind: "counts", counts: { running: 0, queued: 0 } });
  });

  it("sends nothing to another owner", async () => {
    bed = createRunnerBed();
    const other = bed.trigger(undefined, bed.other());
    const frames: unknown[] = [];
    bed.hub.open({
      connectionId: "c2",
      sub: "sub2",
      stream: "tasks",
      key: "u1",
      after: undefined,
      send: (frame) => void frames.push(frame),
    });
    frames.length = 0;
    bed.engine.fire(other.id, other.revision, fireInput({ ownerId: "u2" }));
    expect(frames).toEqual([]);
  });

  it("sends trigger and trigger_removed events when a trigger is saved, switched or deleted", () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    bed.triggers.setEnabled(bed.owner(), trigger.id, true);
    bed.triggers.remove(bed.owner(), trigger.id);
    expect(events().map((event) => event.kind)).toEqual(["trigger", "trigger", "trigger_removed"]);
    expect(events()[1]).toMatchObject({ trigger: { id: trigger.id, enabled: true } });
    expect(events()[2]).toMatchObject({ id: trigger.id });
  });

  it("sends a failure event when one of the owner's effects fails, and failure_dismissed on Dismiss", async () => {
    bed = createRunnerBed();
    bed.outbox.register("attachment.cleanup", async () => ({ outcome: "fail", code: "boom" }));
    enqueueEffect(
      bed.db,
      { kind: "attachment.cleanup", ownerId: "u1", payload: { day: "2026-10-14" } },
      bed.clock.now(),
    );
    await bed.outbox.drain();
    const failure = events().find((event) => event.kind === "failure") as unknown as {
      failure: { id: number; kind: string; lastError: string };
    };
    expect(failure.failure).toMatchObject({ kind: "attachment.cleanup", lastError: "boom" });
    expect(snapshot().failures).toHaveLength(1);
    bed.engine.stream.dismiss("u1", failure.failure.id);
    expect(events().at(-1)).toEqual({ kind: "failure_dismissed", id: failure.failure.id });
    expect(snapshot().failures).toEqual([]);
  });

  it("answers not_found when dismissing an unknown or another owner's failure", () => {
    bed = createRunnerBed();
    bed.db.run(
      `INSERT INTO outbox (kind, replay, owner_id, payload, status, next_at, created_at, settled_at, last_error)
       VALUES ('task.start', 'process-bound', 'u2', '{"taskId":"x"}', 'failed', 0, 1, 1, 'x')`,
    );
    for (const id of [1, 99]) {
      try {
        bed.engine.stream.dismiss("u1", id);
        throw new Error("no refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(PapError);
        expect((error as PapError).code).toBe("not_found");
      }
    }
  });
});
