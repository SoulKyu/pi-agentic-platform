import {
  type FanoutView,
  isSnoozed,
  type LaneView,
  type ProjectSummary,
  type SessionStatus,
  type ShellSession,
  type TaskState,
  type TaskView,
} from "@pap/contracts";
import { sessionLabel } from "../../lib/session-label.ts";
import type { HomeTarget } from "./home-actions.ts";

/** Rows shown at first, and added by each "Show more" (§3.4). */
export const RECENT_PAGE = 20;
export const RECENT_FILTERS = ["all", "sessions", "lanes", "tasks"] as const;
export type RecentFilter = (typeof RECENT_FILTERS)[number];

interface RowBase {
  readonly key: string;
  readonly title: string;
  /** Last activity, in milliseconds. */
  readonly at: number;
  readonly projectId: string | null;
  readonly target: HomeTarget;
}

export type RecentRow =
  | (RowBase & { readonly kind: "session"; readonly state: SessionStatus })
  | (RowBase & { readonly kind: "lane"; readonly state: LaneView["state"] })
  | (RowBase & { readonly kind: "fanout"; readonly state: "active" | "archived"; readonly lanes: number })
  | (RowBase & { readonly kind: "task"; readonly state: TaskState });

export interface RecentInput {
  /** The switcher's project; null: every project. */
  readonly project: { readonly id: string; readonly root: string } | null;
  readonly sessions: ReadonlyMap<string, ShellSession>;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  /** Live lanes first, then the archived page (`lanes.listArchived`): a lane in both counts once, as live. */
  readonly lanes: readonly LaneView[];
  readonly fanouts: ReadonlyMap<string, FanoutView>;
  readonly tasks: readonly TaskView[];
  readonly now: number;
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";
const inside = (cwd: string, folder: string): boolean => cwd === folder || cwd.startsWith(`${folder}/`);

/**
 * §3.4: one list for the project — sessions, lanes (live and archived), tasks, and fan-outs grouped from the lanes that
 * share a `fanoutId` — ordered by last activity. A session that belongs to a lane (its folder is the worktree) or to a
 * task is its lane's or task's row, never a row of its own (Review Focus 5).
 */
export function recentRows(input: RecentInput): RecentRow[] {
  const byId = new Map<string, LaneView>();
  for (const lane of input.lanes) if (!byId.has(lane.id)) byId.set(lane.id, lane);
  const lanes = [...byId.values()];
  const projectOfRoot = new Map([...input.projects.values()].map((project) => [project.root, project.id]));
  const wanted = (projectId: string | null): boolean =>
    input.project === null || projectId === input.project.id;
  const updated = (sessionId: string | null): number =>
    sessionId === null ? 0 : (input.sessions.get(sessionId)?.updatedAt ?? 0);
  const laneAt = (lane: LaneView): number =>
    Math.max(lane.createdAt, lane.archivedAt ?? 0, lane.firstRunEndedAt ?? 0, updated(lane.primarySessionId));
  const taskSessions = new Set(
    input.tasks.flatMap((task) => (task.sessionId === null ? [] : [task.sessionId])),
  );

  const rows: RecentRow[] = [];
  for (const session of input.sessions.values()) {
    if (session.archivedAt !== null || session.settledAt !== null || isSnoozed(session, input.now)) continue;
    if (!wanted(session.projectId) || taskSessions.has(session.id)) continue;
    if (lanes.some((lane) => inside(session.cwd, lane.worktree))) continue;
    rows.push({
      kind: "session",
      key: `session:${session.id}`,
      title: sessionLabel(session) || session.cwd,
      state: session.status,
      at: session.updatedAt,
      projectId: session.projectId,
      target: { kind: "session", id: session.id },
    });
  }
  const groups = new Map<string, LaneView[]>();
  for (const lane of lanes) {
    if (input.project !== null && lane.projectRoot !== input.project.root) continue;
    if (lane.fanoutId !== null) {
      groups.set(lane.fanoutId, [...(groups.get(lane.fanoutId) ?? []), lane]);
      continue;
    }
    rows.push({
      kind: "lane",
      key: `lane:${lane.id}`,
      title: lane.title || lane.branch,
      state: lane.state,
      at: laneAt(lane),
      projectId: projectOfRoot.get(lane.projectRoot) ?? null,
      target: { kind: "lane", id: lane.id },
    });
  }
  for (const [fanoutId, members] of groups) {
    const first = members[0];
    if (first === undefined) continue;
    rows.push({
      kind: "fanout",
      key: `fanout:${fanoutId}`,
      title: firstLine(input.fanouts.get(fanoutId)?.prompt ?? "") || first.title || first.branch,
      state: members.every((lane) => lane.state === "archived") ? "archived" : "active",
      lanes: members.length,
      at: Math.max(...members.map(laneAt)),
      projectId: projectOfRoot.get(first.projectRoot) ?? null,
      target: { kind: "compare", id: fanoutId },
    });
  }
  for (const task of input.tasks) {
    if (!wanted(task.projectId)) continue;
    rows.push({
      kind: "task",
      key: `task:${task.id}`,
      title: task.title,
      state: task.state,
      at: Math.max(task.endedAt ?? task.startedAt ?? task.createdAt, updated(task.sessionId)),
      projectId: task.projectId,
      target: task.sessionId === null ? { kind: "tasks" } : { kind: "session", id: task.sessionId },
    });
  }
  return rows.sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
}

/** The filter chips: All · Sessions · Lanes (fan-outs with them) · Tasks. */
export function filterRows(rows: readonly RecentRow[], filter: RecentFilter): RecentRow[] {
  switch (filter) {
    case "all":
      return [...rows];
    case "sessions":
      return rows.filter((row) => row.kind === "session");
    case "lanes":
      return rows.filter((row) => row.kind === "lane" || row.kind === "fanout");
    case "tasks":
      return rows.filter((row) => row.kind === "task");
  }
}
