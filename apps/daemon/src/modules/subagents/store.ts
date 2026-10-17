import type { SubagentState } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

export interface SubagentRunRow {
  readonly id: string;
  readonly ownerId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string | null;
  readonly profile: string | null;
  readonly title: string;
  readonly state: SubagentState;
  readonly reason: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

const COLUMNS =
  "id, owner_id AS ownerId, parent_session_id AS parentSessionId, child_session_id AS childSessionId, profile, title, state, reason, started_at AS startedAt, ended_at AS endedAt";
const LIVE = "state IN ('starting', 'running')";

/** The `subagent_runs` table (M11R134): one row per call, written by the service and never read back by a client in this task. */
export function createSubagentStore(db: Db) {
  return {
    start(row: {
      id: string;
      ownerId: string;
      parentSessionId: string;
      profile: string | null;
      title: string;
      startedAt: number;
    }): void {
      db.run(
        "INSERT INTO subagent_runs (id, owner_id, parent_session_id, profile, title, state, started_at) VALUES ($id, $ownerId, $parentSessionId, $profile, $title, 'starting', $startedAt)",
        row,
      );
    },
    /** The child exists and is prompted next. */
    running(id: string, childSessionId: string): void {
      db.run(
        "UPDATE subagent_runs SET state = 'running', child_session_id = $childSessionId WHERE id = $id AND state = 'starting'",
        { id, childSessionId },
      );
    },
    /** Ends a live row once; false when it had ended already (how a row ended is never rewritten). */
    finish(
      id: string,
      state: Exclude<SubagentState, "starting" | "running">,
      reason: string | null,
      at: number,
    ): boolean {
      return (
        db.run(
          `UPDATE subagent_runs SET state = $state, reason = $reason, ended_at = $at WHERE id = $id AND ${LIVE}`,
          { id, state, reason, at },
        ).changes > 0
      );
    },
    get: (id: string): SubagentRunRow | undefined =>
      db.get<SubagentRunRow>(`SELECT ${COLUMNS} FROM subagent_runs WHERE id = $id`, { id }),
    /** The parent's newest children that have a session (a `starting` row has none yet), at most `limit`: its screen's list. */
    childrenOf: (parentSessionId: string, limit: number): SubagentRunRow[] =>
      db.all<SubagentRunRow>(
        `SELECT ${COLUMNS} FROM subagent_runs WHERE parent_session_id = $parentSessionId AND child_session_id IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT $limit`,
        { parentSessionId, limit },
      ),
    /** Children of this parent that have not ended (the per-parent cap). */
    liveOf: (parentSessionId: string): number =>
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM subagent_runs WHERE parent_session_id = $parentSessionId AND ${LIVE}`,
        { parentSessionId },
      )?.n ?? 0,
    /** Every call the owner made at or after `since`, ended or not (the per-hour cap). */
    startedSince: (ownerId: string, since: number): number =>
      db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM subagent_runs WHERE owner_id = $ownerId AND started_at >= $since",
        { ownerId, since },
      )?.n ?? 0,
    /** At boot: no child survives a daemon that stopped, so no row may keep counting against its parent. */
    interruptLive(at: number): number {
      return db.run(
        `UPDATE subagent_runs SET state = 'interrupted', reason = 'restart', ended_at = $at WHERE ${LIVE}`,
        { at },
      ).changes;
    },
  };
}
export type SubagentStore = ReturnType<typeof createSubagentStore>;
