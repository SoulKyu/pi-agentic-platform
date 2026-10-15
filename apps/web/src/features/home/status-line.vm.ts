import type { LaneView, TaskView, UsageSummary } from "@pap/contracts";

export type StatusPart =
  | { readonly kind: "lanes"; readonly count: number }
  | { readonly kind: "tasks"; readonly count: number }
  | { readonly kind: "inbox"; readonly count: number }
  | { readonly kind: "spend"; readonly usd: number; readonly none: boolean; readonly apiEquivalent: boolean };

export interface StatusInput {
  /** The switcher's project; null: every project. */
  readonly project: { readonly id: string; readonly root: string } | null;
  readonly lanes: Iterable<LaneView>;
  readonly tasks: readonly TaskView[];
  /** The owner's unread Inbox items: they carry no project (PH11). */
  readonly unread: number;
  /** `usage.summary` over 30 days (PH4); null while it loads or after a failure, and then the part is left out. */
  readonly spend: UsageSummary | null;
}

/** §3.3: `3 active lanes · 1 running task · Inbox 3 · 30 days $4.20`. A part at zero is left out; the spend never is. */
export function statusParts(input: StatusInput): StatusPart[] {
  const { project } = input;
  const lanes = [...input.lanes].filter(
    (lane) => lane.state === "active" && (project === null || lane.projectRoot === project.root),
  ).length;
  const tasks = input.tasks.filter(
    (task) => task.state === "running" && (project === null || task.projectId === project.id),
  ).length;
  const parts: StatusPart[] = [];
  if (lanes > 0) parts.push({ kind: "lanes", count: lanes });
  if (tasks > 0) parts.push({ kind: "tasks", count: tasks });
  if (input.unread > 0) parts.push({ kind: "inbox", count: input.unread });
  if (input.spend !== null)
    parts.push({
      kind: "spend",
      usd: input.spend.totals.costUsd,
      none: input.spend.totals.runs === 0,
      // A subscription bills no tokens: its figure is what the API would have charged (finops.md).
      apiEquivalent: input.spend.byModel.some((row) => row.billing === "subscription"),
    });
  return parts;
}
