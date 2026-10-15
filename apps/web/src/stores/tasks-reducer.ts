import {
  TASK_TERMINAL_STATES,
  TASKS_LIMITS,
  type TaskFailure,
  type TasksCounts,
  TasksStreamEvent,
  type TaskTrigger,
  type TaskView,
} from "@pap/contracts";

export interface TasksView {
  readonly loaded: boolean;
  /** Newest first. Every live task, then as many finished ones as fit under the cap. */
  readonly list: readonly TaskView[];
  readonly truncated: boolean;
  /** By name. */
  readonly triggers: readonly TaskTrigger[];
  /** Newest first. */
  readonly failures: readonly TaskFailure[];
  readonly counts: TasksCounts | null;
  /** Events this build could not read: skipped, never fatal. */
  readonly skipped: number;
}

export const EMPTY_TASKS: TasksView = {
  loaded: false,
  list: [],
  truncated: false,
  triggers: [],
  failures: [],
  counts: null,
  skipped: 0,
};

const finished = (task: TaskView): boolean =>
  (TASK_TERMINAL_STATES as readonly string[]).includes(task.state);
const newest = (a: TaskView, b: TaskView) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
const byName = (a: TaskTrigger, b: TaskTrigger) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
const recent = (a: TaskFailure, b: TaskFailure) => b.settledAt - a.settledAt || b.id - a.id;

/** Past the cap the oldest finished tasks go first, then the oldest of all: a live task is the last to leave. */
function bounded(tasks: Map<string, TaskView>): TaskView[] {
  const list = [...tasks.values()].sort(newest);
  const excess = list.length - TASKS_LIMITS.snapshotTasks;
  if (excess <= 0) return list;
  const drop = new Set(
    [...list]
      .reverse()
      .sort((a, b) => Number(finished(b)) - Number(finished(a)))
      .slice(0, excess)
      .map((task) => task.id),
  );
  return list.filter((task) => !drop.has(task.id));
}

export function reduceTasks(view: TasksView, event: unknown): TasksView {
  const parsed = TasksStreamEvent.safeParse(event);
  if (!parsed.success) return { ...view, skipped: view.skipped + 1 };
  const next = parsed.data;
  switch (next.kind) {
    case "snapshot": {
      const { tasks, truncated, triggers, failures } = next;
      const counts: TasksCounts = {
        paused: next.paused,
        slots: next.slots,
        running: next.running,
        queued: next.queued,
        quietHours: next.quietHours,
        todayUsd: next.todayUsd,
        budgetUsd: next.budgetUsd,
      };
      return {
        loaded: true,
        list: bounded(new Map(tasks.map((task) => [task.id, task]))),
        truncated,
        triggers: [...triggers].sort(byName),
        failures: [...failures].sort(recent).slice(0, TASKS_LIMITS.failures),
        counts,
        skipped: view.skipped,
      };
    }
    case "task": {
      const tasks = new Map(view.list.map((task) => [task.id, task]));
      tasks.set(next.task.id, next.task);
      return { ...view, list: bounded(tasks) };
    }
    case "trigger":
      return {
        ...view,
        triggers: [...view.triggers.filter((trigger) => trigger.id !== next.trigger.id), next.trigger].sort(
          byName,
        ),
      };
    case "trigger_removed":
      return { ...view, triggers: view.triggers.filter((trigger) => trigger.id !== next.id) };
    case "counts":
      return { ...view, counts: next.counts };
    case "failure":
      return {
        ...view,
        failures: [...view.failures.filter((failure) => failure.id !== next.failure.id), next.failure]
          .sort(recent)
          .slice(0, TASKS_LIMITS.failures),
      };
    case "failure_dismissed":
      return { ...view, failures: view.failures.filter((failure) => failure.id !== next.id) };
  }
}
