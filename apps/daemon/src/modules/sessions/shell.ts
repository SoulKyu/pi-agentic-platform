import {
  type ProjectSummary,
  type SessionStatus,
  type SessionSummary,
  SHELL_LIMITS,
  type ShellSession,
  type ShellStreamEvent,
} from "@pap/contracts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { ShellRow } from "./marks-store.ts";

export type ShellSnapshot = Extract<ShellStreamEvent, { kind: "snapshot" }>;

/** The share of the budget kept for the projects no held session names (M4R32): budget / 6, 150 000 of a page. */
export const PROJECT_SHARE = 6;

/** The contract's bound on the snapshot's sessions: the newest window plus the pins. */
const MAX_ROWS = SHELL_LIMITS.sessions + SHELL_LIMITS.pins;

export function summaryOf(
  row: ShellRow,
  live: { readonly status: SessionStatus; readonly needsInput: boolean },
): ShellSession {
  return {
    id: row.id,
    cwd: row.cwd,
    name: row.name,
    preview: row.preview,
    status: live.status,
    needsInput: live.needsInput,
    projectId: row.projectId,
    pinRank: row.marks.pinRank,
    archivedAt: row.marks.archivedAt,
    settledAt: row.marks.settledAt,
    snoozedUntil: row.marks.snoozedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The `shell` snapshot under `budget` JSON bytes (M4R32): sessions in the order given until one does not fit (leaving
 * the projects' share), each bringing its project the first time it names one; then the owner's other active projects
 * in their order while fewer than 500 are in. `more` and `moreProjects` count what was left out.
 */
export function fitShellSnapshot(
  input: {
    readonly sessions: readonly ShellSession[];
    /** Every project of the owner with an active session, in the person's order. */
    readonly projects: readonly ProjectSummary[];
    readonly active: number;
    readonly archived: number;
  },
  budget = PAGE_BYTES,
): ShellSnapshot {
  const snapshot: ShellSnapshot = {
    kind: "snapshot",
    projects: [],
    sessions: [],
    more: 0,
    moreProjects: 0,
    archived: input.archived,
  };
  // Room for the digits `more` and `moreProjects` will have.
  let used = sizeOf(snapshot) + 32;
  const byId = new Map(input.projects.map((project) => [project.id, project]));
  const named = new Set<string>();
  const sessionRoom = budget - Math.floor(budget / PROJECT_SHARE);
  for (const session of input.sessions) {
    if (snapshot.sessions.length >= MAX_ROWS) break;
    const project =
      session.projectId !== null && !named.has(session.projectId) ? byId.get(session.projectId) : undefined;
    const size = sizeOf(session) + 1 + (project ? sizeOf(project) + 1 : 0);
    if (used + size > sessionRoom) break;
    used += size;
    snapshot.sessions.push(session);
    if (project) {
      named.add(project.id);
      snapshot.projects.push(project);
    }
  }
  // The switcher lists every project with an active session, up to 500 (owner Q15, RT-09).
  for (const project of input.projects) {
    if (named.has(project.id)) continue;
    if (snapshot.projects.length >= SHELL_LIMITS.projects) break;
    const size = sizeOf(project) + 1;
    if (used + size > budget) break;
    used += size;
    snapshot.projects.push(project);
  }
  snapshot.more = Math.max(0, input.active - snapshot.sessions.length);
  snapshot.moreProjects = Math.max(0, input.projects.length - snapshot.projects.length);
  return snapshot;
}

/** `sessions.list` under the page (M4R35): the newest kept, `truncated` when one was left out. */
export function fitSummaries(
  list: readonly SessionSummary[],
  budget = PAGE_BYTES,
): { sessions: SessionSummary[]; truncated: boolean } {
  let used = sizeOf({ sessions: [], truncated: true });
  const sessions: SessionSummary[] = [];
  for (const summary of list) {
    const size = sizeOf(summary) + 1;
    if (used + size > budget) return { sessions, truncated: true };
    used += size;
    sessions.push(summary);
  }
  return { sessions, truncated: false };
}
