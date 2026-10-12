import { isSnoozed, type ProjectSummary, type ShellSession } from "@pap/contracts";
import { sessionLabel } from "../../lib/session-label.ts";

export const ROWS_PER_PROJECT = 20;
export const SHELF_ROWS = 50;

export interface TreeGroup {
  /** null: sessions without a project, or of a project the store does not know ("Other folders"); at most one such group. */
  readonly project: ProjectSummary | null;
  readonly sessions: readonly ShellSession[];
  /** Rows the browser holds but the cap hides ("Show 20 more"). */
  readonly hidden: number;
  /** The project's active sessions the browser does not show here ("search with ⌘K"); 0 while filtering. */
  readonly older: number;
}

export interface TreeModel {
  readonly pinned: readonly ShellSession[];
  readonly groups: readonly TreeGroup[];
  readonly snoozed: readonly ShellSession[];
  readonly snoozedMore: number;
  readonly settled: readonly ShellSession[];
  readonly settledMore: number;
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
  const pinned: ShellSession[] = [];
  const snoozed: ShellSession[] = [];
  const settled: ShellSession[] = [];
  const active = new Map<string | null, ShellSession[]>();
  const held = new Map<string | null, number>();
  for (const session of input.sessions) {
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
    else {
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
  const groups = [...active].map(([key, list]): TreeGroup => {
    const sorted = list.toSorted(newest);
    const cap = input.shown.get(key ?? "") ?? ROWS_PER_PROJECT;
    const project = key === null ? null : (input.projects.get(key) ?? null);
    return {
      project,
      sessions: sorted.slice(0, cap),
      hidden: Math.max(0, sorted.length - cap),
      older: project ? olderOf(project) : 0,
    };
  });
  // Projects with active sessions the browser shows no row of: a heading and their "older" line (M4R91, RT-09).
  if (needle === "") {
    for (const project of input.projects.values()) {
      if (active.has(project.id) || !inScope(project.id)) continue;
      const older = olderOf(project);
      if (older > 0) groups.push({ project, sessions: [], hidden: 0, older });
    }
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
    empty: pinned.length === 0 && groups.length === 0 && snoozed.length === 0 && settled.length === 0,
  };
}
