import {
  INBOX_KINDS,
  INBOX_LIMITS,
  type InboxCursor,
  type InboxFilter,
  type InboxItem,
} from "@pap/contracts";
import type { Db, SqlParams } from "../../kernel/db/database.ts";

interface Row {
  readonly id: string;
  readonly owner_id: string;
  readonly kind: string;
  readonly to_handle: number;
  readonly task_id: string | null;
  readonly session_id: string | null;
  readonly title: string;
  readonly cost_usd: number | null;
  readonly created_at: number;
  readonly read_at: number | null;
  readonly resolved_at: number | null;
  readonly resolution: string | null;
  readonly agent_id: string | null;
  readonly ref_id: string | null;
  readonly entry_id: string | null;
  readonly detail: string | null;
}

export interface NewItem {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly toHandle: boolean;
  readonly taskId: string;
  readonly sessionId: string | null;
  /** The trigger's name: the row stores nothing else of the task (M10R46). */
  readonly triggerName: string;
  readonly costUsd: number | null;
  readonly at: number;
  /** The agent whose task this is (M11R92); null for a trigger's own task. */
  readonly agentId?: string | null;
}

/** An item about a request, a staged fact or an agent: one row per `(refId, kind)` (M11R89). */
export interface RefItem {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly toHandle: boolean;
  /** Null for an item about something that is not an agent (a project box). */
  readonly agentId: string | null;
  /** The line shown as the item's subject; none: the agent label. */
  readonly title?: string;
  readonly refId: string;
  readonly entryId: string | null;
  readonly detail: string | null;
  readonly at: number;
}

const FILTER_KINDS: Record<Exclude<InboxFilter, "all">, readonly string[]> = {
  to_handle: INBOX_KINDS.toHandle,
  replies: INBOX_KINDS.replies,
  tasks: INBOX_KINDS.tasks,
};

function itemOf(row: Row): InboxItem {
  return {
    id: row.id,
    kind: row.kind,
    toHandle: row.to_handle === 1,
    taskId: row.task_id,
    sessionId: row.session_id,
    triggerName: row.title,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    readAt: row.read_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution === "answered" || row.resolution === "timed_out" ? row.resolution : null,
    agentId: row.agent_id,
    refId: row.ref_id,
    entryId: row.entry_id,
    detail: row.detail,
  };
}

/** The NOT NULL `title` of an agent item: the row stores no trigger name, and the agent's id lives in `agent_id`. */
const AGENT_ITEM_LABEL = "agent";

const OPEN = "to_handle = 1 AND resolved_at IS NULL";

/** The only writer of `inbox_items` (C §3.2). Every statement names the owner; another owner's row is never read nor touched. */
export function createInboxStore(db: Db) {
  const byTaskKind = (taskId: string, kind: string): InboxItem | null => {
    const row = db.get<Row>("SELECT * FROM inbox_items WHERE task_id = $taskId AND kind = $kind", {
      taskId,
      kind,
    });
    return row ? itemOf(row) : null;
  };
  const insertValues = (item: NewItem) => ({
    id: item.id,
    ownerId: item.ownerId,
    kind: item.kind,
    toHandle: item.toHandle ? 1 : 0,
    taskId: item.taskId,
    sessionId: item.sessionId,
    title: item.triggerName,
    costUsd: item.costUsd,
    at: item.at,
    agentId: item.agentId ?? null,
  });
  const INSERT = `INSERT INTO inbox_items (id, owner_id, kind, to_handle, task_id, session_id, title, cost_usd, created_at, agent_id)
     VALUES ($id, $ownerId, $kind, $toHandle, $taskId, $sessionId, $title, $costUsd, $at, $agentId)`;

  const byRef = (kind: string, refId: string): { item: InboxItem; ownerId: string } | null => {
    const row = db.get<Row>("SELECT * FROM inbox_items WHERE ref_id = $refId AND kind = $kind", {
      refId,
      kind,
    });
    return row ? { item: itemOf(row), ownerId: row.owner_id } : null;
  };

  return {
    byTaskKind,

    /** One item of this owner; another owner's id reads as absent. */
    get(ownerId: string, id: string): InboxItem | null {
      const row = db.get<Row>("SELECT * FROM inbox_items WHERE owner_id = $ownerId AND id = $id", {
        ownerId,
        id,
      });
      return row ? itemOf(row) : null;
    },

    /** An info item: one per task and kind, a second one of the same is not written. True when this call wrote it. */
    insertInfo: (item: NewItem): boolean =>
      db.run(`${INSERT} ON CONFLICT(task_id, kind) WHERE task_id IS NOT NULL DO NOTHING`, insertValues(item))
        .changes === 1,

    /**
     * A question of a task: written, or, when the row of that task was answered already, reopened (RT-11). A question that
     * is still open is left as it is. Returns the row as it stands, or null when nothing changed.
     */
    openQuestion(item: NewItem): InboxItem | null {
      const changed = db.run(
        `${INSERT} ON CONFLICT(task_id, kind) WHERE task_id IS NOT NULL DO UPDATE SET
           resolved_at = NULL, read_at = NULL, resolution = NULL, created_at = excluded.created_at,
           session_id = excluded.session_id, title = excluded.title
         WHERE inbox_items.resolved_at IS NOT NULL`,
        insertValues(item),
      ).changes;
      return changed === 1 ? byTaskKind(item.taskId, item.kind) : null;
    },

    /** Closes the open row of this task and kind; null when there is none open. */
    resolve(
      taskId: string,
      kind: string,
      resolution: "answered" | "timed_out" | null,
      at: number,
    ): InboxItem | null {
      const changed = db.run(
        `UPDATE inbox_items SET resolved_at = $at, resolution = $resolution
         WHERE task_id = $taskId AND kind = $kind AND ${OPEN}`,
        { taskId, kind, at, resolution },
      ).changes;
      return changed === 1 ? byTaskKind(taskId, kind) : null;
    },

    /** The open questions, then the newest others, newest first; one more than asked tells the caller the list was cut. */
    snapshotItems(ownerId: string): { open: InboxItem[]; others: InboxItem[] } {
      const open = db
        .all<Row>(
          `SELECT * FROM inbox_items WHERE owner_id = $ownerId AND ${OPEN} ORDER BY created_at DESC, id DESC`,
          { ownerId },
        )
        .map(itemOf);
      const others = db
        .all<Row>(
          `SELECT * FROM inbox_items WHERE owner_id = $ownerId AND NOT (${OPEN})
           ORDER BY created_at DESC, id DESC LIMIT $limit`,
          { ownerId, limit: INBOX_LIMITS.snapshotOthers },
        )
        .map(itemOf);
      return { open, others };
    },

    /** One page older than the cursor, newest first; `limit + 1` rows are read so the caller knows whether more remain. */
    page(
      ownerId: string,
      before: InboxCursor | undefined,
      limit: number,
      filter: InboxFilter = "all",
    ): InboxItem[] {
      const kinds = filter === "all" ? null : JSON.stringify(FILTER_KINDS[filter]);
      const rows = db.all<Row>(
        `SELECT * FROM inbox_items WHERE owner_id = $ownerId
           ${before ? "AND (created_at, id) < ($createdAt, $id)" : ""}
           ${kinds ? "AND kind IN (SELECT value FROM json_each($kinds))" : ""}
         ORDER BY created_at DESC, id DESC LIMIT $limit`,
        {
          ownerId,
          limit: limit + 1,
          ...(before ? { createdAt: before.createdAt, id: before.id } : {}),
          ...(kinds ? { kinds } : {}),
        },
      );
      return rows.map(itemOf);
    },

    byRef,

    /**
     * Writes the item of `(refId, kind)`, or reopens the owner's row (read and resolution cleared, text replaced). The unique
     * index is not owner-scoped: a conflict with another owner's row changes nothing and returns null.
     */
    upsertRef(item: RefItem): InboxItem | null {
      const changed = db.run(
        `INSERT INTO inbox_items (id, owner_id, kind, to_handle, session_id, title, created_at, agent_id, ref_id, entry_id, detail)
         VALUES ($id, $ownerId, $kind, $toHandle, NULL, $title, $at, $agentId, $refId, $entryId, $detail)
         ON CONFLICT(ref_id, kind) WHERE ref_id IS NOT NULL DO UPDATE SET
           to_handle = excluded.to_handle, resolved_at = NULL, read_at = NULL, resolution = NULL,
           created_at = excluded.created_at, agent_id = excluded.agent_id, title = excluded.title,
           entry_id = excluded.entry_id, detail = excluded.detail
         WHERE inbox_items.owner_id = excluded.owner_id`,
        { ...item, toHandle: item.toHandle ? 1 : 0, at: item.at, title: item.title ?? AGENT_ITEM_LABEL },
      ).changes;
      const written = changed === 1 ? byRef(item.kind, item.refId) : null;
      return written?.ownerId === item.ownerId ? written.item : null;
    },

    /**
     * Closes the owner's open row of this ref and kind; null when there is none. An info item is read as it closes, so its
     * badge clears (W5-R48); a to-handle item keeps M10's behaviour: answering it does not read it.
     */
    resolveRef(
      ownerId: string,
      kind: string,
      refId: string,
      resolution: "answered" | "timed_out" | null,
      at: number,
    ): InboxItem | null {
      const row = db.get<Row>(
        `UPDATE inbox_items SET resolved_at = $at, resolution = $resolution,
           read_at = CASE WHEN to_handle = 0 THEN coalesce(read_at, $at) ELSE read_at END
         WHERE owner_id = $ownerId AND ref_id = $refId AND kind = $kind AND resolved_at IS NULL RETURNING *`,
        { ownerId, kind, refId, at, resolution },
      );
      return row ? itemOf(row) : null;
    },

    /** The open to-handle items of a kind, oldest first, at most `limit` (a module that restarts finds what it raised). */
    openRefs: (kind: string, limit: number): Array<{ ownerId: string; agentId: string; refId: string }> =>
      db
        .all<{ owner_id: string; agent_id: string; ref_id: string }>(
          `SELECT owner_id, agent_id, ref_id FROM inbox_items
           WHERE kind = $kind AND ref_id IS NOT NULL AND agent_id IS NOT NULL AND ${OPEN}
           ORDER BY created_at, id LIMIT $limit`,
          { kind, limit },
        )
        .map((row) => ({ ownerId: row.owner_id, agentId: row.agent_id, refId: row.ref_id })),

    removeRef: (ownerId: string, kind: string, refId: string): boolean =>
      db.run("DELETE FROM inbox_items WHERE owner_id = $ownerId AND ref_id = $refId AND kind = $kind", {
        ownerId,
        kind,
        refId,
      }).changes === 1,

    /** Deletes every item of the owner that carries this agent, resolved or not; the number removed (agent delete). */
    removeAgentItems: (ownerId: string, agentId: string): number =>
      db.run("DELETE FROM inbox_items WHERE owner_id = $ownerId AND agent_id = $agentId", {
        ownerId,
        agentId,
      }).changes,

    counts(ownerId: string): { unread: number; toHandle: number } {
      const row = db.get<{ unread: number; to_handle: number }>(
        `SELECT count(*) FILTER (WHERE read_at IS NULL) AS unread,
                count(*) FILTER (WHERE ${OPEN}) AS to_handle
         FROM inbox_items WHERE owner_id = $ownerId`,
        { ownerId },
      );
      return { unread: row?.unread ?? 0, toHandle: row?.to_handle ?? 0 };
    },

    count: (ownerId: string): number =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM inbox_items WHERE owner_id = $ownerId", { ownerId })
        ?.n ?? 0,

    /** Sets `read_at` on the owner's unread items among `ids` (all of them when `ids` is null); returns the rows changed. */
    markRead(ownerId: string, ids: readonly string[] | null, at: number): InboxItem[] {
      const where = ids === null ? "" : "AND id IN (SELECT value FROM json_each($ids))";
      const params: SqlParams = ids === null ? { ownerId, at } : { ownerId, at, ids: JSON.stringify(ids) };
      return db
        .all<Row>(
          `UPDATE inbox_items SET read_at = $at WHERE owner_id = $ownerId AND read_at IS NULL ${where} RETURNING *`,
          params,
        )
        .map(itemOf);
    },

    /** Removes the owner's oldest read info item (a question is never one); true when one went (M10R49). */
    evictOldestReadInfo: (ownerId: string): boolean =>
      db.run(
        `DELETE FROM inbox_items WHERE id = (
           SELECT id FROM inbox_items WHERE owner_id = $ownerId AND to_handle = 0 AND read_at IS NOT NULL
           ORDER BY created_at, id LIMIT 1)`,
        { ownerId },
      ).changes === 1,

    /** Read items whose question is resolved (or that never asked one), created before `before`. */
    removeReadBefore: (before: number): number =>
      db.run(
        `DELETE FROM inbox_items WHERE read_at IS NOT NULL AND created_at < $before
           AND (to_handle = 0 OR resolved_at IS NOT NULL)`,
        { before },
      ).changes,

    transaction: <T>(fn: () => T): T => db.transaction(fn),
  };
}
