import type { AgentRequestView } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

interface RequestRow {
  readonly id: string;
  readonly agent_id: string;
  readonly kind: "approve" | "secret";
  readonly title: string;
  readonly detail: string | null;
  readonly created_at: number;
  readonly expires_at: number;
}

const COLUMNS = "id, agent_id, kind, title, detail, created_at, expires_at";

const viewOf = (row: RequestRow): AgentRequestView => ({
  id: row.id,
  agentId: row.agent_id,
  kind: row.kind,
  title: row.title,
  detail: row.detail,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** What the `agents` stream reads of `agent_requests`. Rows are written by the requests service (Task 17), never here. */
export function createRequestViews(db: Db) {
  return {
    /** The owner's pending requests, oldest first. */
    pending: (ownerId: string, limit: number): AgentRequestView[] =>
      db
        .all<RequestRow>(
          `SELECT ${COLUMNS} FROM agent_requests WHERE owner_id = $ownerId AND state = 'pending'
           ORDER BY created_at, id LIMIT $limit`,
          { ownerId, limit },
        )
        .map(viewOf),

    /** The agents of this owner that wait for an answer. */
    waiting: (ownerId: string): Set<string> =>
      new Set(
        db
          .all<{ agent_id: string }>(
            "SELECT DISTINCT agent_id FROM agent_requests WHERE owner_id = $ownerId AND state = 'pending'",
            { ownerId },
          )
          .map((row) => row.agent_id),
      ),

    /** The request as the stream shows it, and whether it still waits; null when there is no such row of the owner. */
    find(ownerId: string, id: string): { request: AgentRequestView; pending: boolean } | null {
      const row = db.get<RequestRow & { state: string }>(
        `SELECT ${COLUMNS}, state FROM agent_requests WHERE id = $id AND owner_id = $ownerId`,
        { id, ownerId },
      );
      return row ? { request: viewOf(row), pending: row.state === "pending" } : null;
    },
  };
}
export type RequestViews = ReturnType<typeof createRequestViews>;
