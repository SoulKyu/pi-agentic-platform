import type { AgentStatus, TaskView, TriggerView } from "@pap/contracts";
import { formatCost, type ChipTone } from "@pap/ui";
import { stripHidden } from "./untrusted-text.ts";

/** DESIGN §8: the panel is a column on the right, a pane of its own, or a sheet. */
export type PanelLayout = "side" | "pane" | "sheet";

export const panelLayout = (wide: boolean, phone: boolean): PanelLayout =>
  phone ? "sheet" : wide ? "side" : "pane";

/** At 1280 px the cockpit fits a 330 px column beside the thread. */
export const WIDE_QUERY = "(min-width: 1280px)";

export function formatTokens(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  if (n < 1000) return String(n);
  if (n < 999_950) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (value: number): string => value.toFixed(1).replace(/\.0$/, "");

export interface MeterVm {
  readonly kind: "tokens" | "cost";
  readonly value: number;
  readonly max: number;
  /** "$1.20 / $5.00" or "12.4k / 50k". */
  readonly valueText: string;
}

export type BudgetVm =
  | { readonly kind: "none"; readonly spent: string }
  | { readonly kind: "set"; readonly meters: readonly MeterVm[]; readonly over: boolean };

/** Bars only when the agent has a budget (owner m14: none by default); each half is its own bar. */
export function budgetVm(today: AgentStatus["today"]): BudgetVm {
  const meters: MeterVm[] = [];
  if (today.budgetTokens !== null)
    meters.push({
      kind: "tokens",
      value: today.tokens,
      max: today.budgetTokens,
      valueText: `${formatTokens(today.tokens)} / ${formatTokens(today.budgetTokens)}`,
    });
  if (today.budgetUsd !== null)
    meters.push({
      kind: "cost",
      value: today.usd,
      max: today.budgetUsd,
      valueText: `${formatCost(today.usd)} / ${formatCost(today.budgetUsd)}`,
    });
  if (meters.length === 0)
    return { kind: "none", spent: `${formatCost(today.usd)} · ${formatTokens(today.tokens)}` };
  const over =
    (today.budgetTokens !== null && today.tokens > today.budgetTokens) ||
    (today.budgetUsd !== null && today.usd > today.budgetUsd);
  return { kind: "set", meters, over };
}

const TASK_TONE: Readonly<Record<TaskView["state"], ChipTone>> = {
  queued: "mut",
  running: "run",
  limited: "mut",
  done: "ok",
  failed: "err",
  cancelled: "mut",
  interrupted: "err",
};

/** The word of a task's chip: its state, or `input` while a question waits for the owner. */
export type TaskWord = TaskView["state"] | "input";

export interface TaskRowVm {
  readonly id: string;
  readonly title: string;
  readonly tone: ChipTone;
  readonly stateWord: TaskWord;
  readonly at: number;
  /** The session to open; null for a task that has none (queued, or gone). */
  readonly sessionId: string | null;
}

/** Task text is untrusted: hidden characters are removed before it is drawn. */
export function taskRows(tasks: readonly TaskView[]): readonly TaskRowVm[] {
  return tasks.map((task) => ({
    id: task.id,
    title: stripHidden(task.title),
    tone: needsInput(task) ? "att" : TASK_TONE[task.state],
    stateWord: needsInput(task) ? "input" : task.state,
    at: task.endedAt ?? task.startedAt ?? task.createdAt,
    sessionId: task.sessionId,
  }));
}
const needsInput = (task: TaskView): boolean => task.state === "running" && task.needsInput;

const GLYPH = { schedule: "⏱", webhook: "⇢", feed: "◉", manual: "▸" } as const;

export interface TriggerRowVm {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  readonly enabled: boolean;
  /** The owner's Run button: any source type; the daemon would also fire a disabled one, the row just hides it. */
  readonly canFire: boolean;
}

export const triggerRows = (triggers: readonly TriggerView[]): readonly TriggerRowVm[] =>
  triggers.map((trigger) => ({
    id: trigger.id,
    name: stripHidden(trigger.name),
    glyph: trigger.source === null ? "?" : GLYPH[trigger.source.type],
    enabled: trigger.enabled,
    canFire: trigger.enabled,
  }));

/** "5 min ago", "yesterday": the panel's times are about recency. */
export function ago(now: number, at: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}
