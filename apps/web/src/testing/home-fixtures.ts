import type { TaskView, UsageSummary } from "@pap/contracts";

/** A finished task of project p1, from trigger g1. */
export const taskView = (patch: Partial<TaskView> & { id: string }): TaskView => ({
  triggerId: "g1",
  triggerName: "nightly",
  projectId: "p1",
  state: "done",
  reason: null,
  origin: "schedule",
  title: `task ${patch.id}`,
  detail: null,
  createdAt: 1,
  startedAt: null,
  endedAt: null,
  sessionId: null,
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  ...patch,
});

/** The first event of the `tasks` stream. */
export const tasksSnapshot = (
  tasks: TaskView[],
  counts: { readonly paused?: boolean; readonly budgetUsd?: number | null } = {},
) => ({
  kind: "snapshot",
  paused: counts.paused ?? false,
  slots: 2,
  running: tasks.filter((task) => task.state === "running").length,
  queued: 0,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: counts.budgetUsd ?? null,
  tasks,
  truncated: false,
  triggers: [],
  failures: [],
});

/** `usage.summary`'s answer: one model row when there were runs. */
export const usageSummary = (
  patch: {
    readonly costUsd?: number;
    readonly runs?: number;
    readonly billing?: "api" | "subscription";
  } = {},
): UsageSummary => ({
  from: 0,
  to: 1,
  timeZone: "UTC",
  totals: { costUsd: patch.costUsd ?? 0, tokens: 0, runs: patch.runs ?? 0 },
  byOrigin: [],
  byModel:
    (patch.runs ?? 0) > 0
      ? [
          {
            costUsd: patch.costUsd ?? 0,
            tokens: 0,
            runs: patch.runs ?? 0,
            provider: "anthropic",
            model: "sonnet",
            billing: patch.billing ?? "api",
          },
        ]
      : [],
  metrics: false,
  otlpHost: null,
});
