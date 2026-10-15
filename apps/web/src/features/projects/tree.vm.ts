import {
  isSnoozed,
  type LaneStatus,
  type LaneView,
  type ProjectSummary,
  type ShellSession,
} from "@pap/contracts";
import { inLane, laneStatusOf } from "../../lib/lane-sessions.ts";
import { sessionLabel } from "../../lib/session-label.ts";
import { isLiveLane } from "../../stores/lane-reducer.ts";

export const ROWS_PER_PROJECT = 20;
export const SHELF_ROWS = 50;

/** A stored "rows shown" count that is safe to `slice` with: a whole number, never below the default (NaN, negatives, fractions). */
export const clampShown = (count: number | undefined): number =>
  count === undefined || Number.isNaN(count)
    ? ROWS_PER_PROJECT
    : Math.max(ROWS_PER_PROJECT, Math.floor(count));

/** A lane under its project: its status, and the sessions that run in its worktree (the active ones, M9R61). */
export interface TreeLane {
  readonly lane: LaneView;
  readonly status: LaneStatus;
  readonly sessions: readonly ShellSession[];
}

export interface TreeGroup {
  /** null: sessions without a project, or of a project the store does not know ("Other folders"); at most one such group. */
  readonly project: ProjectSummary | null;
  readonly sessions: readonly ShellSession[];
  /** Rows the browser holds but the cap hides ("Show 20 more"). */
  readonly hidden: number;
  /** The project's active sessions the browser does not show here ("search with ⌘K"); 0 while filtering. */
  readonly older: number;
  /** The project's lanes that are not archived, newest first; empty while the lane store is. */
  readonly lanes: readonly TreeLane[];
}

export interface TreeModel {
  readonly pinned: readonly ShellSession[];
  readonly groups: readonly TreeGroup[];
  readonly snoozed: readonly ShellSession[];
  readonly snoozedMore: number;
  readonly settled: readonly ShellSession[];
  readonly settledMore: number;
  /** The count of the "Archived lanes" entry that ends the tree; 0 hides it. */
  readonly archivedLanes: number;
  readonly empty: boolean;
}

export interface TreeInput {
  readonly sessions: Iterable<ShellSession>;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  readonly filter: string;
  /** The effective current project (Task 24): only it and the pinned sessions show; null shows every project. */
  readonly projectId: string | null;
  /** Rows shown per project id ("" for the group without a project). */
  readonly shown: ReadonlyMap<string, number>;
  readonly now: number;
  /** The owner's lanes (the `lane` stream) and how many are archived. */
  readonly lanes?: { readonly items: Iterable<LaneView>; readonly archived: number };
}

const normalize = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const newest = (a: ShellSession, b: ShellSession): number =>
  b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);

export function buildTree(input: TreeInput): TreeModel {
  const needle = normalize(input.filter.trim());
  const matches = (session: ShellSession): boolean => {
    if (needle === "") return true;
    const project = session.projectId === null ? "" : (input.projects.get(session.projectId)?.name ?? "");
    return normalize(`${sessionLabel(session)} ${session.cwd} ${project}`).includes(needle);
  };
  const inScope = (projectId: string | null): boolean =>
    input.projectId === null || projectId === input.projectId;
  // One group key per project id, and one for everything else: group keys (and React keys) cannot repeat.
  const groupKey = (projectId: string | null): string | null =>
    projectId !== null && input.projects.has(projectId) ? projectId : null;
  const allSessions = [...input.sessions];
  const liveLanes = [...(input.lanes?.items ?? [])].filter(isLiveLane);
  const laneOf = (session: ShellSession): LaneView | undefined =>
    liveLanes.find((lane) => inLane(lane, session.cwd));
  const laneSessionLists = new Map<string, ShellSession[]>();
  const pinned: ShellSession[] = [];
  const snoozed: ShellSession[] = [];
  const settled: ShellSession[] = [];
  const active = new Map<string | null, ShellSession[]>();
  const held = new Map<string | null, number>();
  for (const session of allSessions) {
    if (session.archivedAt !== null) continue;
    held.set(session.projectId, (held.get(session.projectId) ?? 0) + 1);
    if (!matches(session)) continue;
    const asleep = isSnoozed(session, input.now);
    if (session.pinRank !== null && !asleep) {
      pinned.push(session);
      continue;
    }
    if (!inScope(session.projectId)) continue;
    if (asleep) snoozed.push(session);
    else if (session.settledAt !== null) settled.push(session);
    else if (laneOf(session)) {
      // A lane's session shows under its lane row, never loose under the project.
      const own = laneOf(session) as LaneView;
      laneSessionLists.set(own.id, [...(laneSessionLists.get(own.id) ?? []), session]);
    } else {
      const key = groupKey(session.projectId);
      const list = active.get(key);
      if (list === undefined) active.set(key, [session]);
      else list.push(session);
    }
  }
  pinned.sort((a, b) => (a.pinRank ?? 0) - (b.pinRank ?? 0) || (a.id < b.id ? -1 : 1));
  snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0) || (a.id < b.id ? -1 : 1));
  settled.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0) || (a.id < b.id ? -1 : 1));
  const olderOf = (project: ProjectSummary): number =>
    needle === "" ? Math.max(0, project.sessions - (held.get(project.id) ?? 0)) : 0;
  const projectKeyOfLane = (lane: LaneView): string | null => {
    for (const project of input.projects.values())
      if (project.root === lane.projectRoot) return groupKey(project.id);
    return null;
  };
  const laneRows = new Map<string | null, TreeLane[]>();
  for (const lane of liveLanes) {
    const key = projectKeyOfLane(lane);
    if (!inScope(key)) continue;
    const own = (laneSessionLists.get(lane.id) ?? []).toSorted(newest);
    const text = normalize(`${lane.title} ${lane.branch}`);
    if (needle !== "" && own.length === 0 && !text.includes(needle)) continue;
    const row: TreeLane = { lane, status: laneStatusOf(lane, allSessions), sessions: own };
    laneRows.set(key, [...(laneRows.get(key) ?? []), row]);
  }
  for (const rows of laneRows.values())
    rows.sort((a, b) => b.lane.createdAt - a.lane.createdAt || (a.lane.id < b.lane.id ? -1 : 1));
  const groups = [...active].map(([key, list]): TreeGroup => {
    const sorted = list.toSorted(newest);
    const cap = clampShown(input.shown.get(key ?? ""));
    const project = key === null ? null : (input.projects.get(key) ?? null);
    return {
      project,
      sessions: sorted.slice(0, cap),
      hidden: Math.max(0, sorted.length - cap),
      older: project ? olderOf(project) : 0,
      lanes: laneRows.get(key) ?? [],
    };
  });
  // Projects with active sessions the browser shows no row of: a heading and their "older" line (M4R91, RT-09).
  if (needle === "") {
    for (const project of input.projects.values()) {
      if (active.has(project.id) || !inScope(project.id)) continue;
      const older = olderOf(project);
      if (older > 0)
        groups.push({ project, sessions: [], hidden: 0, older, lanes: laneRows.get(project.id) ?? [] });
    }
  }
  // Projects (and the "other folders" group) that have lanes and no loose session still get their heading.
  for (const [key, rows] of laneRows) {
    if (groups.some((group) => (group.project?.id ?? null) === key)) continue;
    groups.push({
      project: key === null ? null : (input.projects.get(key) ?? null),
      sessions: [],
      hidden: 0,
      older: 0,
      lanes: rows,
    });
  }
  groups.sort((a, b) => {
    if (a.project === null || b.project === null) return a.project === null ? 1 : -1;
    return (
      a.project.position - b.project.position ||
      a.project.name.localeCompare(b.project.name) ||
      (a.project.id < b.project.id ? -1 : 1)
    );
  });
  return {
    pinned,
    groups,
    snoozed: snoozed.slice(0, SHELF_ROWS),
    snoozedMore: Math.max(0, snoozed.length - SHELF_ROWS),
    settled: settled.slice(0, SHELF_ROWS),
    settledMore: Math.max(0, settled.length - SHELF_ROWS),
    archivedLanes: input.lanes?.archived ?? 0,
    empty:
      pinned.length === 0 &&
      groups.length === 0 &&
      snoozed.length === 0 &&
      settled.length === 0 &&
      laneRows.size === 0,
  };
}
