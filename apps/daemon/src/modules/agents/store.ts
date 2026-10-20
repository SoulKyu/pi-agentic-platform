import { AgentInput } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

/** How long a deleted agent stays in the trash (RT-40: pap-vmd keeps its disk that long). */
const TRASH_KEEP_MS = 7 * 86_400_000;

/** An agent as the other modules read it. `input` is null when the stored profile no longer parses (M11R43). */
export interface AgentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly input: AgentInput | null;
  readonly threadSessionId: string | null;
  readonly unread: number;
  readonly paused: boolean;
  readonly quarantinedAt: number | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AgentRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly profile: string;
  readonly thread_session_id: string | null;
  readonly unread: number;
  readonly paused: number;
  readonly quarantined_at: number | null;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface NewAgent {
  readonly id: string;
  readonly ownerId: string;
  readonly input: AgentInput;
  readonly profile: string;
  readonly at: number;
}

export interface AgentChange {
  readonly name: string;
  readonly profile: string;
  readonly at: number;
}

/** The profile as stored, parsed again: the column and the profile must agree on the name, or the row is unreadable. */
function inputOf(row: AgentRow): AgentInput | null {
  try {
    const parsed = AgentInput.safeParse(JSON.parse(row.profile) as unknown);
    return parsed.success && parsed.data.name === row.name ? parsed.data : null;
  } catch {
    return null;
  }
}

function recordOf(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    input: inputOf(row),
    threadSessionId: row.thread_session_id,
    unread: row.unread,
    paused: row.paused === 1,
    quarantinedAt: row.quarantined_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The only writer of `agents` (C §3.2). Every statement names the owner; another owner's row is never read or touched. */
export function createAgentStore(db: Db) {
  const one = (ownerId: string, id: string): AgentRow | undefined =>
    db.get<AgentRow>("SELECT * FROM agents WHERE id = $id AND owner_id = $ownerId", { id, ownerId });
  /** AVM-E42 M1: a trash row older than the keep time is gone for every owner, at a delete and at a listing. */
  const pruneTrash = (now: number): void =>
    void db.run("DELETE FROM agent_trash WHERE deleted_at <= $since", { since: now - TRASH_KEEP_MS });
  return {
    get(ownerId: string, id: string): AgentRecord | null {
      const row = one(ownerId, id);
      return row ? recordOf(row) : null;
    },

    byName(ownerId: string, name: string): AgentRecord | null {
      const row = db.get<AgentRow>(
        "SELECT * FROM agents WHERE owner_id = $ownerId AND name_key = lower($name)",
        {
          ownerId,
          name,
        },
      );
      return row ? recordOf(row) : null;
    },

    list: (ownerId: string): AgentRecord[] =>
      db
        .all<AgentRow>("SELECT * FROM agents WHERE owner_id = $ownerId ORDER BY created_at, id", { ownerId })
        .map(recordOf),

    count: (ownerId: string): number =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM agents WHERE owner_id = $ownerId", { ownerId })?.n ??
      0,

    /** Whose agent this is, for a module that holds an agent id and no owner (the memory review queue). */
    ownerOf: (id: string): string | null =>
      db.get<{ owner_id: string }>("SELECT owner_id FROM agents WHERE id = $id", { id })?.owner_id ?? null,

    exists: (id: string): boolean => db.get("SELECT 1 AS n FROM agents WHERE id = $id", { id }) !== undefined,

    insert(agent: NewAgent): void {
      db.run(
        `INSERT INTO agents (id, owner_id, name, name_key, profile, revision, created_at, updated_at)
         VALUES ($id, $ownerId, $name, lower($name), $profile, 1, $at, $at)`,
        {
          id: agent.id,
          ownerId: agent.ownerId,
          name: agent.input.name,
          profile: agent.profile,
          at: agent.at,
        },
      );
    },

    /** Compare-and-set on the revision: true when this call changed the row. */
    update: (ownerId: string, id: string, baseRevision: number, change: AgentChange): boolean =>
      db.run(
        `UPDATE agents SET name = $name, name_key = lower($name), profile = $profile, revision = revision + 1,
           updated_at = $at
         WHERE id = $id AND owner_id = $ownerId AND revision = $baseRevision`,
        { id, ownerId, baseRevision, name: change.name, profile: change.profile, at: change.at },
      ).changes === 1,

    /** One statement; the revision stays (a switch is not an edit of the profile). */
    setPaused: (ownerId: string, id: string, paused: boolean): boolean =>
      db.run("UPDATE agents SET paused = $paused WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
        paused: paused ? 1 : 0,
      }).changes === 1,

    /** Paused for good until the owner acts: the CHECK keeps `quarantined_at` and `paused` together. */
    quarantine: (ownerId: string, id: string, at: number): boolean =>
      db.run("UPDATE agents SET paused = 1, quarantined_at = $at WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
        at,
      }).changes === 1,

    /** Back to work: the switch and the quarantine are cleared together (the CHECK keeps them paired). */
    resume: (ownerId: string, id: string): boolean =>
      db.run("UPDATE agents SET paused = 0, quarantined_at = NULL WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
      }).changes === 1,

    /** The agent whose thread this session is (the runs observer's run end names the session only). */
    byThread(sessionId: string): AgentRecord | null {
      const row = db.get<AgentRow>("SELECT * FROM agents WHERE thread_session_id = $sessionId", {
        sessionId,
      });
      return row ? recordOf(row) : null;
    },

    /**
     * Compare-and-set on the thread: true when the agent still had `expected` (a new thread also clears the unread count
     * of the old one). The unique index `agents_thread` refuses a session that is already some agent's thread.
     */
    setThread: (ownerId: string, id: string, expected: string | null, sessionId: string): boolean =>
      db.run(
        `UPDATE agents SET thread_session_id = $sessionId, unread = 0
         WHERE id = $id AND owner_id = $ownerId AND thread_session_id IS $expected`,
        { id, ownerId, expected, sessionId },
      ).changes === 1,

    /** The thread is let go and the owner has read all there is: the next open starts a new one (M11R60). */
    clearThread: (ownerId: string, id: string, at: number): boolean =>
      db.run(
        `UPDATE agents SET thread_session_id = NULL, unread = 0, read_at = $at
         WHERE id = $id AND owner_id = $ownerId`,
        { id, ownerId, at },
      ).changes === 1,

    /** A counter, never a list: it stops at the column's cap (M11R61). The agent after the change, null when none matched. */
    bumpUnread(ownerId: string, id: string): AgentRecord | null {
      const row = db.get<AgentRow>(
        `UPDATE agents SET unread = min(unread + 1, 1000000) WHERE id = $id AND owner_id = $ownerId RETURNING *`,
        { id, ownerId },
      );
      return row ? recordOf(row) : null;
    },

    markRead: (ownerId: string, id: string, at: number): boolean =>
      db.run("UPDATE agents SET unread = 0, read_at = $at WHERE id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
        at,
      }).changes === 1,

    /** Deletes the row and, in the same transaction, leaves the trash row the owner's trash entry lists (J1b). */
    remove: (ownerId: string, id: string, at: number): boolean =>
      db.transaction(() => {
        pruneTrash(at);
        db.run(
          `INSERT OR REPLACE INTO agent_trash (agent_id, owner_id, name, deleted_at)
           SELECT id, owner_id, name, $at FROM agents WHERE id = $id AND owner_id = $ownerId`,
          { id, ownerId, at },
        );
        return (
          db.run("DELETE FROM agents WHERE id = $id AND owner_id = $ownerId", { id, ownerId }).changes === 1
        );
      }),

    /** The owner's deleted agents still in the trash (newest first): a VM agent's disk is kept 7 days (RT-40). */
    trashed(ownerId: string, now: number): Array<{ agentId: string; name: string; deletedAt: number }> {
      pruneTrash(now);
      return db
        .all<{ agent_id: string; name: string; deleted_at: number }>(
          `SELECT agent_id, name, deleted_at FROM agent_trash
           WHERE owner_id = $ownerId ORDER BY deleted_at DESC, agent_id LIMIT 32`,
          { ownerId },
        )
        .map((row) => ({ agentId: row.agent_id, name: row.name, deletedAt: row.deleted_at }));
    },

    /** Whether the owner has this deleted agent in the trash (the entry is the proof "Purge now" is theirs to ask). */
    inTrash: (ownerId: string, id: string): boolean =>
      db.get("SELECT 1 AS n FROM agent_trash WHERE agent_id = $id AND owner_id = $ownerId", {
        id,
        ownerId,
      }) !== undefined,

    /** The entry goes once its disk and mirrors have (or after 7 days, at a delete or a listing). */
    dropTrash: (ownerId: string, id: string): boolean =>
      db.run("DELETE FROM agent_trash WHERE agent_id = $id AND owner_id = $ownerId", { id, ownerId })
        .changes === 1,

    transaction: <T>(fn: () => T): T => db.transaction(fn),
  };
}
export type AgentStore = ReturnType<typeof createAgentStore>;
