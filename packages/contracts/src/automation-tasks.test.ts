import { describe, expect, it } from "vitest";
import { methods, STREAMS, TASKS_LIMITS, TaskView, TasksStreamEvent, TOKEN_PERMISSIONS } from "./index.ts";

const taskView = {
  id: "t1",
  triggerId: "g1",
  triggerName: "Nightly",
  projectId: null,
  state: "running",
  reason: null,
  origin: "manual",
  title: "Nightly check",
  detail: null,
  createdAt: 1,
  startedAt: 2,
  endedAt: null,
  sessionId: "s1",
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
};
const counts = {
  paused: false,
  slots: 2,
  running: 1,
  queued: 0,
  quietHours: false,
  todayUsd: 0.5,
  budgetUsd: 5,
};

describe("the tasks board contract", () => {
  it("adds the tasks stream", () => {
    expect(STREAMS).toContain("tasks");
  });

  it("declares cancel, retry and dismiss as automation:operate mutations a token may call, and the stream as a read", () => {
    for (const name of [
      "automation.tasks.cancel",
      "automation.tasks.retry",
      "automation.failures.dismiss",
    ] as const) {
      expect(methods[name]).toMatchObject({ permission: "automation:operate", idempotent: false });
    }
    expect(methods["subscribe.tasks"]).toMatchObject({ permission: "automation:read", idempotent: true });
    expect(TOKEN_PERMISSIONS).toContain("automation:operate");
    expect(methods["automation.tasks.retry"].errors).toEqual(
      expect.arrayContaining(["conflict", "automation_paused", "rate_limited"]),
    );
  });

  it("takes only a task id, or an effect id, and no extra field", () => {
    expect(methods["automation.tasks.cancel"].params.safeParse({ taskId: "t" }).success).toBe(true);
    expect(methods["automation.tasks.cancel"].params.safeParse({ taskId: "t", force: true }).success).toBe(
      false,
    );
    expect(methods["automation.failures.dismiss"].params.safeParse({ effectId: 3 }).success).toBe(true);
    expect(methods["automation.failures.dismiss"].params.safeParse({ effectId: "3" }).success).toBe(false);
    expect(methods["subscribe.tasks"].params.safeParse({}).success).toBe(true);
  });

  it("parses a task view and refuses a field it does not know, or a state it does not list", () => {
    expect(TaskView.safeParse(taskView).success).toBe(true);
    expect(TaskView.safeParse({ ...taskView, prompt: "secret" }).success).toBe(false);
    expect(TaskView.safeParse({ ...taskView, waiting: { reason: "image_build", position: 1 } }).success).toBe(
      true,
    );
    expect(TaskView.safeParse({ ...taskView, waiting: null }).success).toBe(true);
    expect(TaskView.safeParse({ ...taskView, waiting: { reason: "tired" } }).success).toBe(false);
    expect(TaskView.safeParse({ ...taskView, state: "paused" }).success).toBe(false);
    expect(TaskView.safeParse({ ...taskView, detail: "x".repeat(513) }).success).toBe(false);
  });

  it("parses every event of the stream", () => {
    const failure = { id: 4, kind: "task.start", lastError: "crash", settledAt: 9 };
    const trigger = {
      id: "g1",
      name: "n",
      enabled: true,
      sourceType: "webhook",
      projectId: null,
      state: "ok",
      nextFireAt: null,
    };
    for (const event of [
      {
        kind: "snapshot",
        ...counts,
        tasks: [taskView],
        truncated: false,
        triggers: [trigger],
        failures: [failure],
      },
      { kind: "task", task: taskView, previous: "queued" },
      { kind: "task", task: taskView, previous: null },
      { kind: "trigger", trigger },
      { kind: "trigger_removed", id: "g1" },
      { kind: "counts", counts },
      { kind: "failure", failure },
      { kind: "failure_dismissed", id: 4 },
    ])
      expect(TasksStreamEvent.safeParse(event).success, JSON.stringify(event)).toBe(true);
    expect(TasksStreamEvent.safeParse({ kind: "future" }).success).toBe(false);
  });

  it("bounds a snapshot to 300 tasks and 20 failures", () => {
    const base = { kind: "snapshot", ...counts, tasks: [], truncated: false, triggers: [], failures: [] };
    const tasks = Array.from({ length: TASKS_LIMITS.snapshotTasks + 1 }, () => taskView);
    expect(TasksStreamEvent.safeParse({ ...base, tasks }).success).toBe(false);
    const failures = Array.from({ length: TASKS_LIMITS.failures + 1 }, (_, n) => ({
      id: n + 1,
      kind: "k",
      lastError: null,
      settledAt: 1,
    }));
    expect(TasksStreamEvent.safeParse({ ...base, failures }).success).toBe(false);
  });
});
