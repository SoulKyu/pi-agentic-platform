import { TASKS_LIMITS, type TaskView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { EMPTY_TASKS, reduceTasks } from "./tasks-reducer.ts";

const task = (n: number, overrides: Partial<TaskView> = {}): TaskView => ({
  id: `task-${String(n).padStart(4, "0")}`,
  triggerId: "g1",
  triggerName: "Nightly",
  projectId: null,
  state: "queued",
  reason: null,
  origin: "manual",
  title: `Task ${n}`,
  detail: null,
  createdAt: n,
  startedAt: null,
  endedAt: null,
  sessionId: null,
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  ...overrides,
});
const counts = {
  paused: false,
  slots: 2,
  running: 0,
  queued: 1,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: 5,
};
const trigger = (id: string, name = id) => ({
  id,
  name,
  enabled: true,
  sourceType: "manual" as const,
  projectId: null,
  state: "ok" as const,
  nextFireAt: null,
});
const failure = (id: number) => ({ id, kind: "task.start", lastError: "crash", settledAt: id });
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  kind: "snapshot",
  ...counts,
  tasks: [task(1), task(2)],
  truncated: false,
  triggers: [trigger("g2", "b"), trigger("g1", "a")],
  failures: [failure(1), failure(2)],
  ...overrides,
});

describe("tasks reducer", () => {
  it("a snapshot replaces everything and marks the view loaded: tasks newest first, triggers by name, failures newest first", () => {
    const first = reduceTasks(EMPTY_TASKS, snapshot());
    expect(first.loaded).toBe(true);
    expect(first.list.map((entry) => entry.id)).toEqual(["task-0002", "task-0001"]);
    expect(first.triggers.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(first.failures.map((entry) => entry.id)).toEqual([2, 1]);
    expect(first.counts).toEqual(counts);
    const second = reduceTasks(first, snapshot({ tasks: [task(9)], failures: [], truncated: true }));
    expect(second.list.map((entry) => entry.id)).toEqual(["task-0009"]);
    expect(second.failures).toEqual([]);
    expect(second.truncated).toBe(true);
  });

  it("a task event adds or replaces by id and keeps the order", () => {
    let view = reduceTasks(EMPTY_TASKS, snapshot());
    view = reduceTasks(view, { kind: "task", task: task(3), previous: null });
    view = reduceTasks(view, {
      kind: "task",
      task: task(1, { state: "running", startedAt: 5 }),
      previous: "queued",
    });
    expect(view.list.map((entry) => [entry.id, entry.state])).toEqual([
      ["task-0003", "queued"],
      ["task-0002", "queued"],
      ["task-0001", "running"],
    ]);
  });

  it("a trigger event adds or replaces, and trigger_removed removes", () => {
    let view = reduceTasks(EMPTY_TASKS, snapshot());
    view = reduceTasks(view, { kind: "trigger", trigger: { ...trigger("g1", "a"), enabled: false } });
    view = reduceTasks(view, { kind: "trigger", trigger: trigger("g3", "c") });
    expect(view.triggers.map((entry) => [entry.id, entry.enabled])).toEqual([
      ["g1", false],
      ["g2", true],
      ["g3", true],
    ]);
    view = reduceTasks(view, { kind: "trigger_removed", id: "g2" });
    expect(view.triggers.map((entry) => entry.id)).toEqual(["g1", "g3"]);
  });

  it("counts replace the numbers over the board", () => {
    const view = reduceTasks(reduceTasks(EMPTY_TASKS, snapshot()), {
      kind: "counts",
      counts: { ...counts, running: 2, paused: true },
    });
    expect(view.counts).toMatchObject({ running: 2, paused: true });
  });

  it("a failure event adds, failure_dismissed removes; at most 20 are kept, the newest", () => {
    let view = reduceTasks(EMPTY_TASKS, snapshot({ failures: [] }));
    for (let id = 1; id <= TASKS_LIMITS.failures + 3; id++)
      view = reduceTasks(view, { kind: "failure", failure: failure(id) });
    expect(view.failures).toHaveLength(TASKS_LIMITS.failures);
    expect(view.failures[0]?.id).toBe(TASKS_LIMITS.failures + 3);
    view = reduceTasks(view, { kind: "failure_dismissed", id: TASKS_LIMITS.failures + 3 });
    expect(view.failures.some((entry) => entry.id === TASKS_LIMITS.failures + 3)).toBe(false);
  });

  it("holds at most 300 tasks, dropping the oldest finished ones first and never a live one", () => {
    const all = Array.from({ length: TASKS_LIMITS.snapshotTasks }, (_, n) =>
      task(n + 10, n === 5 ? { state: "done", endedAt: 1 } : {}),
    );
    let view = reduceTasks(EMPTY_TASKS, snapshot({ tasks: all }));
    view = reduceTasks(view, { kind: "task", task: task(1), previous: null });
    expect(view.list).toHaveLength(TASKS_LIMITS.snapshotTasks);
    expect(view.list.some((entry) => entry.id === task(15).id)).toBe(false);
    expect(view.list.some((entry) => entry.id === task(1).id)).toBe(true);
  });

  it("an unknown kind or an invalid event leaves the state and is counted", () => {
    const base = reduceTasks(EMPTY_TASKS, snapshot());
    const unknown = reduceTasks(base, { kind: "future" });
    expect(unknown.list).toBe(base.list);
    expect(unknown.skipped).toBe(1);
    expect(reduceTasks(unknown, { kind: "task", task: { id: "x" }, previous: null }).skipped).toBe(2);
  });
});
