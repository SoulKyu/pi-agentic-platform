import { type ProjectSummary, SHELL_LIMITS, type ShellSession, ShellStreamEvent } from "@pap/contracts";

export interface PendingChange {
  readonly sessions: ReadonlyArray<{ readonly before: ShellSession; readonly after: ShellSession }>;
  readonly projects: ReadonlyArray<{ readonly before: ProjectSummary; readonly after: ProjectSummary }>;
}

export interface ShellView {
  readonly loaded: boolean;
  readonly unreadable: boolean;
  /** Why the server refused the `shell` subscription; null once a snapshot came (M4R138). */
  readonly failed: string | null;
  readonly sessions: ReadonlyMap<string, ShellSession>;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  /** Active sessions the snapshot left out: older than its window. */
  readonly more: number;
  /** Active projects the snapshot left out: past 500 (owner Q15). */
  readonly moreProjects: number;
  readonly archived: number;
  /** Changes shown before the daemon answered, by commandId (M4R82, M4R83). */
  readonly pending: ReadonlyMap<string, PendingChange>;
}

export const EMPTY_SHELL: ShellView = {
  loaded: false,
  unreadable: false,
  failed: null,
  sessions: new Map(),
  projects: new Map(),
  more: 0,
  moreProjects: 0,
  archived: 0,
  pending: new Map(),
};

export const MAX_STORE_SESSIONS = SHELL_LIMITS.sessions + SHELL_LIMITS.pins;
export const MAX_STORE_PROJECTS = SHELL_LIMITS.projects + SHELL_LIMITS.pins;

/** Archived first, then the oldest that are not pinned (M4R80). */
function boundSessions(sessions: Map<string, ShellSession>): Map<string, ShellSession> {
  if (sessions.size <= MAX_STORE_SESSIONS) return sessions;
  const evictable = [...sessions.values()]
    .filter((session) => session.pinRank === null)
    .sort(
      (a, b) => Number(b.archivedAt !== null) - Number(a.archivedAt !== null) || a.updatedAt - b.updatedAt,
    );
  for (const session of evictable.slice(0, sessions.size - MAX_STORE_SESSIONS)) sessions.delete(session.id);
  return sessions;
}

/** Projects no held session names go first, the empty ones before the others (M4R80). */
function boundProjects(
  projects: Map<string, ProjectSummary>,
  sessions: ReadonlyMap<string, ShellSession>,
): Map<string, ProjectSummary> {
  if (projects.size <= MAX_STORE_PROJECTS) return projects;
  const named = new Set([...sessions.values()].map((session) => session.projectId));
  const evictable = [...projects.values()]
    .filter((project) => !named.has(project.id))
    .sort((a, b) => Number(a.sessions > 0) - Number(b.sessions > 0));
  for (const project of evictable.slice(0, projects.size - MAX_STORE_PROJECTS)) projects.delete(project.id);
  return projects;
}

export function reduceShell(view: ShellView, raw: unknown): ShellView {
  const parsed = ShellStreamEvent.safeParse(raw);
  if (!parsed.success)
    return (raw as { kind?: unknown } | null)?.kind === "snapshot"
      ? { ...view, loaded: true, unreadable: true }
      : view;
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return {
        ...EMPTY_SHELL,
        loaded: true,
        sessions: new Map(event.sessions.map((session) => [session.id, session])),
        projects: new Map(event.projects.map((project) => [project.id, project])),
        more: event.more,
        moreProjects: event.moreProjects,
        archived: event.archived,
      };
    case "session": {
      const sessions = boundSessions(new Map(view.sessions).set(event.session.id, event.session));
      return { ...view, sessions };
    }
    case "project":
      return {
        ...view,
        projects: boundProjects(new Map(view.projects).set(event.project.id, event.project), view.sessions),
      };
    case "counts":
      return { ...view, archived: event.archived };
  }
}

/** The server refused the subscription (M4R138): the tree says so instead of waiting for ever. */
export const failShell = (view: ShellView, code: string): ShellView => ({ ...view, failed: code });

export function optimistic(
  view: ShellView,
  commandId: string,
  change: { readonly sessions?: readonly ShellSession[]; readonly projects?: readonly ProjectSummary[] },
): ShellView {
  const sessions = new Map(view.sessions);
  const projects = new Map(view.projects);
  const pending: PendingChange = {
    sessions: (change.sessions ?? []).flatMap((after) => {
      const before = view.sessions.get(after.id);
      if (!before) return [];
      sessions.set(after.id, after);
      return [{ before, after }];
    }),
    projects: (change.projects ?? []).flatMap((after) => {
      const before = view.projects.get(after.id);
      if (!before) return [];
      projects.set(after.id, after);
      return [{ before, after }];
    }),
  };
  return { ...view, sessions, projects, pending: new Map(view.pending).set(commandId, pending) };
}

/** The pending entry goes and what it shows stays: the answer came, or its outcome is unknown and a snapshot follows. */
export function confirm(view: ShellView, commandId: string): ShellView {
  if (!view.pending.has(commandId)) return view;
  const pending = new Map(view.pending);
  pending.delete(commandId);
  return { ...view, pending };
}

export function rollback(view: ShellView, commandId: string): ShellView {
  const change = view.pending.get(commandId);
  if (!change) return view;
  const sessions = new Map(view.sessions);
  for (const { before, after } of change.sessions)
    if (sessions.get(after.id) === after) sessions.set(before.id, before);
  const projects = new Map(view.projects);
  for (const { before, after } of change.projects)
    if (projects.get(after.id) === after) projects.set(before.id, before);
  const pending = new Map(view.pending);
  pending.delete(commandId);
  return { ...view, sessions, projects, pending };
}

export const pinnedIds = (view: ShellView): string[] =>
  [...view.sessions.values()]
    .filter((session) => session.pinRank !== null)
    .sort((a, b) => (a.pinRank ?? 0) - (b.pinRank ?? 0))
    .map((session) => session.id);
