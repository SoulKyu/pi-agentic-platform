import {
  TASK_TERMINAL_STATES,
  TASKS_LIMITS,
  type ProjectSummary,
  type TasksCounts,
  type TaskTrigger,
  type TaskView,
} from "@pap/contracts";
import { formatCost, formatDuration, type RunStatus } from "@pap/ui";
import { errorKey, t, type MessageKey } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";

/** What a card can offer, in the order its buttons show. */
export type TaskAction = "steer" | "reply" | "cancel" | "retry" | "open" | "resumeNow" | "releaseTools";

/** Actions that open or drive the task's session: a task without one offers none of them. */
const NEEDS_SESSION: readonly TaskAction[] = ["steer", "reply", "open", "resumeNow"];

const isTerminal = (task: TaskView): boolean =>
  (TASK_TERMINAL_STATES as readonly string[]).includes(task.state);

/** Board 11 §2 and M10R114: exactly these buttons per state ("Use my normal tools" only on a finished task whose list is still on). */
export function actionsFor(task: TaskView): TaskAction[] {
  const tools: TaskAction[] =
    isTerminal(task) && !task.toolsReleased && task.sessionId !== null ? ["releaseTools"] : [];
  let actions: TaskAction[];
  switch (task.state) {
    case "running":
      actions = task.needsInput ? ["reply"] : ["steer", "cancel"];
      break;
    case "queued":
      actions = ["cancel"];
      break;
    case "failed":
    case "interrupted":
    case "cancelled":
      actions = ["retry", "open", ...tools];
      break;
    case "done":
      actions = ["open", ...tools];
      break;
    case "limited":
      actions = ["resumeNow", "cancel", "open"];
      break;
  }
  return task.sessionId === null ? actions.filter((action) => !NEEDS_SESSION.includes(action)) : actions;
}

export interface CardStatus {
  /** A run status draws the chip with its dot; null: a plain chip. */
  readonly status: RunStatus | null;
  readonly tone: "run" | "ok" | "att" | "err" | "mut";
  readonly label: MessageKey;
}

/** M10R114's tones: running run, needs input att, queued mut, done ok, failed and interrupted err, limited and cancelled mut. */
export function cardStatus(task: TaskView): CardStatus {
  switch (task.state) {
    case "running":
      return task.needsInput
        ? { status: "needs-input", tone: "att", label: "automation.state.input" }
        : { status: "working", tone: "run", label: "automation.state.running" };
    case "queued":
      return { status: null, tone: "mut", label: "automation.state.queued" };
    case "done":
      return { status: "settled", tone: "ok", label: "automation.state.done" };
    case "failed":
      return { status: "interrupted", tone: "err", label: "automation.state.failed" };
    case "interrupted":
      return { status: "interrupted", tone: "err", label: "automation.state.interrupted" };
    case "limited":
      return { status: "limited", tone: "mut", label: "automation.state.limited" };
    case "cancelled":
      return { status: null, tone: "mut", label: "automation.state.cancelled" };
  }
}

/** Needs input first, then running, queued, and the rest; inside a group the newest first. */
function rank(task: TaskView): number {
  if (task.state === "running") return task.needsInput ? 0 : 1;
  if (task.state === "queued") return 2;
  return 3;
}
const byRank = (a: TaskView, b: TaskView) => rank(a) - rank(b) || b.createdAt - a.createdAt;

export interface BoardColumn {
  /** The project id, or "other" for the column of tasks and triggers no known project owns. */
  readonly key: string;
  readonly name: string | null;
  readonly projectId: string | null;
  readonly triggers: readonly TaskTrigger[];
  readonly tasks: readonly TaskView[];
}

/** One column per project that has a trigger or a task; the rest fall in "Other folders", last. */
export function groupColumns(
  tasks: readonly TaskView[],
  triggers: readonly TaskTrigger[],
  projects: ReadonlyMap<string, ProjectSummary>,
): BoardColumn[] {
  const keyOf = (projectId: string | null): string =>
    projectId !== null && projects.has(projectId) ? projectId : "other";
  const keys = new Set([
    ...tasks.map((task) => keyOf(task.projectId)),
    ...triggers.map((trigger) => keyOf(trigger.projectId)),
  ]);
  const known = [...projects.values()]
    .filter((project) => keys.has(project.id))
    .sort((a, b) => a.position - b.position);
  const column = (key: string, project: ProjectSummary | undefined): BoardColumn => ({
    key,
    name: project?.name ?? null,
    projectId: project?.id ?? null,
    triggers: triggers.filter((trigger) => keyOf(trigger.projectId) === key),
    tasks: tasks.filter((task) => keyOf(task.projectId) === key).sort(byRank),
  });
  return [
    ...known.map((project) => column(project.id, project)),
    ...(keys.has("other") ? [column("other", undefined)] : []),
  ];
}

const startOfDay = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

/** The spend of the tasks that started today (a run in progress counts, M10R113). */
export function costToday(tasks: readonly TaskView[], now: number): number {
  const since = startOfDay(now);
  return tasks.reduce(
    (sum, task) => ((task.startedAt ?? task.createdAt) >= since ? sum + task.costUsd : sum),
    0,
  );
}

export const taskCost = (task: TaskView): string => formatCost(task.costUsd);

/** `3m40`, `00:07`, `1h05`; null for a task that has not started. */
export function taskDuration(task: TaskView, now: number): string | null {
  return task.startedAt === null ? null : formatDuration((task.endedAt ?? now) - task.startedAt);
}

export const countRunning = (tasks: readonly TaskView[]): number =>
  tasks.reduce((count, task) => (task.state === "running" ? count + 1 : count), 0);

/** The quiet-hours chip shows while the owner's window is on (the daemon decides, from the owner's zone). */
export const quietNow = (counts: TasksCounts | null): boolean => counts?.quietHours === true;

export function budgetText(counts: TasksCounts): string {
  const spent = formatCost(counts.todayUsd);
  return counts.budgetUsd === null
    ? t("automation.board.todayNoBudget", { spent })
    : t("automation.board.today", { spent, budget: formatCost(counts.budgetUsd) });
}

const NAME_CHARS = 80;
const TEXT_CAPS = { name: NAME_CHARS, detail: TASKS_LIMITS.detailChars, code: 64 } as const;

/** Untrusted text as visible text (hidden characters written out) and clipped: it is rendered as a React text node only. */
export function shown(text: string, cap: keyof typeof TEXT_CAPS): string {
  const points = Array.from(escapeHidden(text));
  return points.length > TEXT_CAPS[cap] ? `${points.slice(0, TEXT_CAPS[cap]).join("")}…` : points.join("");
}

export type FailingAction = "cancel" | "retry" | "resumeNow" | "releaseTools" | "dismiss";

const SPECIFIC: Readonly<Record<string, MessageKey>> = {
  "cancel.conflict": "automation.error.cancel.conflict",
  "cancel.not_found": "automation.error.cancel.not_found",
  "retry.conflict": "automation.error.retry.conflict",
  "retry.not_found": "automation.error.retry.not_found",
  "resumeNow.conflict": "automation.error.resumeNow.conflict",
  "resumeNow.not_found": "automation.error.resumeNow.not_found",
  "releaseTools.not_found": "automation.error.releaseTools.not_found",
  "dismiss.not_found": "automation.error.dismiss.not_found",
};

/** The fixed text for a refusal: a sentence that fits the action where one exists, else the code's own (`budget_reached`, `automation_paused`...). */
export function actionErrorText(action: FailingAction, code: string): string {
  return t(SPECIFIC[`${action}.${code}`] ?? errorKey(code));
}
