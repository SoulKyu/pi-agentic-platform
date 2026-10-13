import {
  type Caller,
  type ProjectSummary,
  SHELL_LIMITS,
  type ShellSession,
  type ShellStreamEvent,
} from "@pap/contracts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { MarksStore } from "./marks-store.ts";
import { fitShellSnapshot, summaryOf } from "./shell.ts";

/** The sidebar's reads: every one is filtered by the owner id the transport gave, never by a param. */
export function createShellView(deps: {
  readonly store: MarksStore;
  readonly projects: ProjectsPort;
  live(sessionId: string): { status: ShellSession["status"]; needsInput: boolean };
}) {
  const summary = (sessionId: string): { ownerId: string; session: ShellSession } | null => {
    const row = deps.store.row(sessionId);
    return row ? { ownerId: row.ownerId, session: summaryOf(row, deps.live(row.id)) } : null;
  };
  const project = (ownerId: string, projectId: string): ProjectSummary | null => {
    const view = deps.projects.list(ownerId, [projectId])[0];
    return view ? { ...view, sessions: deps.store.countByProject(ownerId, projectId) } : null;
  };
  return {
    summary,
    project,
    snapshot(ownerId: string): ShellStreamEvent {
      const rows = deps.store.window(ownerId, SHELL_LIMITS.sessions + SHELL_LIMITS.pins);
      const counts = deps.store.activeByProject(ownerId);
      // Every project with an active session, in the person's order (owner Q15, M4R132).
      const projects = deps.projects
        .list(ownerId, [...counts.keys()])
        .map((view) => ({ ...view, sessions: counts.get(view.id) ?? 0 }));
      return fitShellSnapshot({
        sessions: rows.map((row) => summaryOf(row, deps.live(row.id))),
        projects,
        active: deps.store.countActive(ownerId),
        archived: deps.store.countArchived(ownerId),
      });
    },
    listArchived(
      caller: Caller,
      params: { before?: { archivedAt: number; id: string } | undefined; limit?: number | undefined },
    ) {
      const limit = params.limit ?? SHELL_LIMITS.archivedPage;
      const rows = deps.store.archivedPage(caller.userId, params.before ?? null, limit + 1);
      const sessions: ShellSession[] = [];
      let used = sizeOf({ sessions: [], hasMore: true });
      for (const row of rows.slice(0, limit)) {
        const session = summaryOf(row, deps.live(row.id));
        const size = sizeOf(session) + 1;
        if (used + size > PAGE_BYTES) return { sessions, hasMore: true };
        used += size;
        sessions.push(session);
      }
      return { sessions, hasMore: rows.length > limit };
    },
    /** A summary for search hits: only the owner's own session. */
    summaryFor(sessionId: string, ownerId: string): ShellSession | null {
      const found = summary(sessionId);
      return found && found.ownerId === ownerId ? found.session : null;
    },
  };
}
