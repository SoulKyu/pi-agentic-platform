import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { IsMember } from "../../kernel/box-path.ts";
import type { ProjectsPort } from "../projects/index.ts";
import { boxCwdOf } from "./box-cwd.ts";
import type { MarksStore } from "./marks-store.ts";

const PAGE = 500;

export interface ProjectLink {
  /** The owner's project for a folder, made on demand (M4R28); null when it cannot be made. Never throws. */
  projectOf(ownerId: string, cwd: string): string | null;
  /** Sets and returns the project of a stored session (adopted sessions, Task 14). */
  assign(sessionId: string, ownerId: string, cwd: string): string | null;
  /** A fork or a clone files under its source's project (RT-20). */
  copy(fromSessionId: string, toSessionId: string): string | null;
  /** Rows stored before M4 (or whose project could not be made), page by page by id: returns the rows it assigned (M4R29). */
  backfill(): number;
}

export function createProjectLink(deps: {
  readonly store: MarksStore;
  readonly projects: ProjectsPort;
  scopeOf(cwd: string): string;
  /** A gated owner's cwd is never looked up on the host (`scopeOf` stats it). */
  readonly isMember: IsMember;
  /** The box projects, bound late: a box cwd links to its own project, never through `scopeOf`. */
  readonly boxes?: (() => ProjectBoxSource | undefined) | undefined;
  readonly logger: Logger;
}): ProjectLink {
  const projectOf = (ownerId: string, cwd: string): string | null => {
    const box = boxCwdOf(deps.boxes?.(), ownerId, cwd);
    if (box) return box.projectId;
    if (deps.isMember(ownerId)) return null;
    try {
      return deps.projects.ensure(ownerId, deps.scopeOf(cwd))?.id ?? null;
    } catch (error) {
      // The session goes under "Other folders"; the next boot's backfill tries again.
      deps.logger.warn("session_project_failed", { err: error });
      return null;
    }
  };
  // A session that exists keeps working without its project: a write that fails is logged, not thrown.
  const store = (sessionId: string, projectId: string | null): string | null => {
    try {
      deps.store.setProject(sessionId, projectId);
      return projectId;
    } catch (error) {
      deps.logger.warn("session_project_failed", { sessionId, err: error });
      return null;
    }
  };
  return {
    projectOf,
    assign(sessionId, ownerId, cwd) {
      const projectId = projectOf(ownerId, cwd);
      return store(sessionId, projectId);
    },
    copy(fromSessionId, toSessionId) {
      return store(toSessionId, deps.store.row(fromSessionId)?.projectId ?? null);
    },
    backfill() {
      let after = "";
      let assigned = 0;
      // One `scopeOf` per owner and folder; local to this call, at most one entry per row read.
      const known = new Map<string, string | null>();
      for (;;) {
        const rows = deps.store.withoutProject(after, PAGE);
        for (const row of rows) {
          const key = JSON.stringify([row.ownerId, row.cwd]);
          if (!known.has(key)) known.set(key, projectOf(row.ownerId, row.cwd));
          const projectId = known.get(key) ?? null;
          if (projectId === null) continue;
          deps.store.setProject(row.id, projectId);
          assigned++;
        }
        if (rows.length < PAGE) break;
        after = rows.at(-1)?.id ?? after;
      }
      if (assigned > 0) deps.logger.info("session_projects_backfilled", { sessions: assigned });
      return assigned;
    },
  };
}
