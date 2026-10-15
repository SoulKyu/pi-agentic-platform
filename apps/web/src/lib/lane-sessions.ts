import { deriveLaneStatus, type LaneStatus, type LaneView } from "@pap/contracts";

interface SessionFacts {
  readonly cwd: string;
  readonly status: string;
  readonly needsInput: boolean;
  readonly archivedAt?: number | null;
}

/** A session belongs to a lane when its folder is the worktree or inside it; `…/fix-a-1a2b-x` is not inside `…/fix-a-1a2b`. */
export const inLane = (lane: Pick<LaneView, "worktree">, cwd: string): boolean =>
  cwd === lane.worktree || cwd.startsWith(lane.worktree.endsWith("/") ? lane.worktree : `${lane.worktree}/`);

export function laneSessions<S extends SessionFacts>(
  lane: Pick<LaneView, "worktree">,
  sessions: Iterable<S>,
): S[] {
  const found: S[] = [];
  for (const session of sessions)
    if (session.archivedAt == null && inLane(lane, session.cwd)) found.push(session);
  return found;
}

/** The lane's status (the contract's order) from the sessions the shell store holds. */
export function laneStatusOf(lane: LaneView, sessions: Iterable<SessionFacts>): LaneStatus {
  const own = laneSessions(lane, sessions);
  return deriveLaneStatus(lane, {
    busy: own.some((session) => session.status === "running"),
    needsInput: own.some((session) => session.needsInput),
  }).status;
}
