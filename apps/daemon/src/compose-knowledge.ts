import type { Caller } from "@pap/contracts";
import type { AuditPort } from "./modules/audit/index.ts";
import type { LaneRow } from "./modules/lanes/index.ts";
import type { ProjectKnowledge, ProjectView } from "./modules/projects/index.ts";

/** What the roots need of modules built after the projects module: read when asked, never at construction. */
interface Late {
  readonly projects: {
    port: {
      list(ownerId: string, ids: readonly string[]): ProjectView[];
      covers(ownerId: string, path: string): boolean;
    };
  };
  readonly lanes: { paths: { laneOf(cwd: string): LaneRow | null } };
  readonly sessions: { cwdOf(ownerId: string, sessionId: string): string | null };
}

/**
 * Which folder's `knowledge/` a session sees: a lane session's worktree, else the project's folder (not the session's
 * own, which may lie below it). A folder in another owner's lane, or in another project's lane, counts as plain.
 */
export function composeKnowledge(audit: Pick<AuditPort, "append">, late: () => Late): ProjectKnowledge {
  const rootAt = (ownerId: string, projectId: string, cwd: string | null): string | null => {
    const project = late().projects.port.list(ownerId, [projectId])[0];
    if (!project) return null;
    const lane = cwd === null ? null : late().lanes.paths.laneOf(cwd);
    return lane && lane.ownerId === ownerId && lane.projectRoot === project.root
      ? lane.worktree
      : project.root;
  };
  return {
    rootOfRow: (row, scope) => {
      const lane = late().lanes.paths.laneOf(row.cwd);
      if (lane && lane.ownerId === row.ownerId) return lane.worktree;
      // A folder outside every project has no knowledge root (spec §3).
      return late().projects.port.covers(row.ownerId, scope) ? scope : null;
    },
    rootFor: (ownerId, projectId, sessionId) =>
      rootAt(ownerId, projectId, sessionId === undefined ? null : late().sessions.cwdOf(ownerId, sessionId)),
    enabled: (caller: Caller, projectId) =>
      audit.append({
        ownerId: caller.userId,
        actor: caller.kind === "token" ? "token" : "user",
        ...(caller.kind === "token" && caller.credentialId ? { actorId: caller.credentialId } : {}),
        kind: "policy",
        reason: "knowledge_enabled",
        detail: { projectId },
      }),
  };
}
