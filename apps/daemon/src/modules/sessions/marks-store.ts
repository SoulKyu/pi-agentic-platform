import type { Marks } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

/** A session as the sidebar sees it: identity, label sources, project and marks. */
export interface ShellRow {
  readonly id: string;
  readonly ownerId: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly preview: string | null;
  readonly projectId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly marks: Marks;
}

interface RawRow {
  id: string;
  ownerId: string;
  cwd: string;
  name: string | null;
  preview: string | null;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  pinRank: number | null;
  archivedAt: number | null;
  settledAt: number | null;
  settledAuto: number;
  unsettledAt: number | null;
  snoozedUntil: number | null;
}

/** The Pi ids kept for one draft: one per worker it was started with, the most a person would cause. */
const MAX_PENDING_IDS = 32;

const COLUMNS =
  "id, owner_id AS ownerId, cwd, name, preview, project_id AS projectId, created_at AS createdAt, updated_at AS updatedAt, " +
  "pin_rank AS pinRank, archived_at AS archivedAt, settled_at AS settledAt, settled_auto AS settledAuto, " +
  "unsettled_at AS unsettledAt, snoozed_until AS snoozedUntil";

const rowOf = (raw: RawRow): ShellRow => ({
  id: raw.id,
  ownerId: raw.ownerId,
  cwd: raw.cwd,
  name: raw.name,
  preview: raw.preview,
  projectId: raw.projectId,
  createdAt: raw.createdAt,
  updatedAt: raw.updatedAt,
  marks: {
    pinRank: raw.pinRank,
    archivedAt: raw.archivedAt,
    settledAt: raw.settledAt,
    settledAuto: raw.settledAuto === 1,
    unsettledAt: raw.unsettledAt,
    snoozedUntil: raw.snoozedUntil,
  },
});

/** A session found by one of its Pi identities. */
export interface PiMatch {
  readonly id: string;
  readonly ownerId: string;
  readonly piPath: string | null;
}

export interface MarksStore {
  row(id: string): ShellRow | undefined;
  /** Not archived: pinned first by rank, then the newest; at most `limit`. */
  window(ownerId: string, limit: number): ShellRow[];
  countActive(ownerId: string): number;
  countArchived(ownerId: string): number;
  /** Sessions not archived, by project (the snapshot's counts and its active projects, one query). */
  activeByProject(ownerId: string): Map<string, number>;
  countByProject(ownerId: string, projectId: string): number;
  /** Archived, newest archive first, strictly after the cursor. */
  archivedPage(ownerId: string, before: { archivedAt: number; id: string } | null, limit: number): ShellRow[];
  /** The owner's pinned sessions by rank. */
  pins(ownerId: string): string[];
  /** One session's marks and, when given, the owner's pin order (ranks 1..n, others unpinned), in one transaction. */
  write(id: string, marks: Marks, pins: { ownerId: string; order: readonly string[] } | null): void;
  setProject(id: string, projectId: string | null): void;
  /** Only when the session has none yet; true when it was written. */
  setPreview(id: string, preview: string): boolean;
  /** The Pi id a worker reported for a row without a Pi file (M4R123); false when the row has a file. */
  setPendingPiId(id: string, piSessionId: string): boolean;
  /** Sessions with no project, by id after `afterId`. */
  withoutProject(afterId: string, limit: number): Array<{ id: string; ownerId: string; cwd: string }>;
  findByPiPath(path: string): { id: string; ownerId: string } | undefined;
  findByPiSessionId(piSessionId: string): PiMatch | undefined;
  /** The session whose worker reported this Pi id before Pi wrote its file (RT-01). */
  findByPendingPiId(piSessionId: string): PiMatch | undefined;
  dueSnoozes(now: number, limit: number): string[];
  nextSnooze(): number | null;
  /** Idle since before `cutoff`, and not pinned, snoozed, settled, archived or unsettled since `cutoff`. */
  settleCandidates(cutoff: number, limit: number): string[];
}

export function createMarksStore(db: Db): MarksStore {
  const ids = (sql: string, params: Record<string, string | number | null>) =>
    db.all<{ id: string }>(sql, params).map((row) => row.id);
  return {
    row: (id) => {
      const raw = db.get<RawRow>(`SELECT ${COLUMNS} FROM sessions WHERE id = $id`, { id });
      return raw ? rowOf(raw) : undefined;
    },
    window: (ownerId, limit) =>
      db
        .all<RawRow>(
          `SELECT ${COLUMNS} FROM sessions WHERE owner_id = $ownerId AND archived_at IS NULL ` +
            "ORDER BY pin_rank IS NULL, pin_rank, updated_at DESC, id LIMIT $limit",
          { ownerId, limit },
        )
        .map(rowOf),
    countActive: (ownerId) =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM sessions WHERE owner_id = $ownerId AND archived_at IS NULL",
        {
          ownerId,
        },
      )?.n ?? 0,
    countArchived: (ownerId) =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM sessions WHERE owner_id = $ownerId AND archived_at IS NOT NULL",
        { ownerId },
      )?.n ?? 0,
    activeByProject: (ownerId) =>
      new Map(
        db
          .all<{ projectId: string; n: number }>(
            "SELECT project_id AS projectId, count(*) AS n FROM sessions WHERE owner_id = $ownerId AND archived_at IS NULL AND project_id IS NOT NULL GROUP BY project_id",
            { ownerId },
          )
          .map((row) => [row.projectId, row.n]),
      ),
    countByProject: (ownerId, projectId) =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM sessions WHERE owner_id = $ownerId AND project_id = $projectId AND archived_at IS NULL",
        { ownerId, projectId },
      )?.n ?? 0,
    archivedPage: (ownerId, before, limit) =>
      db
        .all<RawRow>(
          `SELECT ${COLUMNS} FROM sessions WHERE owner_id = $ownerId AND archived_at IS NOT NULL ` +
            "AND ($at IS NULL OR archived_at < $at OR (archived_at = $at AND id < $id)) ORDER BY archived_at DESC, id DESC LIMIT $limit",
          { ownerId, at: before?.archivedAt ?? null, id: before?.id ?? "", limit },
        )
        .map(rowOf),
    pins: (ownerId) =>
      ids(
        "SELECT id FROM sessions WHERE owner_id = $ownerId AND pin_rank IS NOT NULL ORDER BY pin_rank, id",
        {
          ownerId,
        },
      ),
    write: (id, marks, pins) =>
      db.transaction(() => {
        db.run(
          "UPDATE sessions SET pin_rank = $pinRank, archived_at = $archivedAt, settled_at = $settledAt, settled_auto = $settledAuto, " +
            "unsettled_at = $unsettledAt, snoozed_until = $snoozedUntil WHERE id = $id",
          { id, ...marks, settledAuto: marks.settledAuto ? 1 : 0 },
        );
        if (!pins) return;
        db.run(
          "UPDATE sessions SET pin_rank = NULL WHERE owner_id = $ownerId AND pin_rank IS NOT NULL AND id NOT IN (SELECT value FROM json_each($order))",
          { ownerId: pins.ownerId, order: JSON.stringify(pins.order) },
        );
        pins.order.forEach((pinned, index) =>
          db.run("UPDATE sessions SET pin_rank = $rank WHERE id = $id AND owner_id = $ownerId", {
            id: pinned,
            ownerId: pins.ownerId,
            rank: index + 1,
          }),
        );
      }),
    setProject: (id, projectId) => {
      db.run("UPDATE sessions SET project_id = $projectId WHERE id = $id", { id, projectId });
    },
    setPreview: (id, preview) =>
      db.run("UPDATE sessions SET preview = $preview WHERE id = $id AND preview IS NULL", { id, preview })
        .changes > 0,
    setPendingPiId: (id, piSessionId) =>
      db.transaction(() => {
        const draft = db.get<{ id: string }>("SELECT id FROM sessions WHERE id = $id AND pi_path IS NULL", {
          id,
        });
        if (!draft) return false;
        // The column keeps the first id; a later one never replaces it (M4R60).
        db.run(
          "UPDATE sessions SET pending_pi_session_id = $piSessionId WHERE id = $id AND pending_pi_session_id IS NULL",
          {
            id,
            piSessionId,
          },
        );
        db.run(
          "INSERT OR IGNORE INTO session_pending_ids (session_id, pi_session_id) SELECT $id, $piSessionId " +
            `WHERE (SELECT count(*) FROM session_pending_ids WHERE session_id = $id) < ${MAX_PENDING_IDS}`,
          { id, piSessionId },
        );
        return true;
      }),
    withoutProject: (afterId, limit) =>
      db.all<{ id: string; ownerId: string; cwd: string }>(
        "SELECT id, owner_id AS ownerId, cwd FROM sessions WHERE project_id IS NULL AND id > $afterId ORDER BY id LIMIT $limit",
        { afterId, limit },
      ),
    findByPiPath: (path) =>
      db.get<{ id: string; ownerId: string }>(
        "SELECT id, owner_id AS ownerId FROM sessions WHERE pi_path = $path",
        {
          path,
        },
      ),
    findByPiSessionId: (piSessionId) =>
      db.get<PiMatch>(
        "SELECT id, owner_id AS ownerId, pi_path AS piPath FROM sessions WHERE pi_session_id = $piSessionId",
        { piSessionId },
      ),
    findByPendingPiId: (piSessionId) =>
      db.get<PiMatch>(
        "SELECT s.id AS id, s.owner_id AS ownerId, s.pi_path AS piPath FROM session_pending_ids p " +
          "JOIN sessions s ON s.id = p.session_id WHERE p.pi_session_id = $piSessionId " +
          "ORDER BY s.created_at DESC, s.id LIMIT 1",
        { piSessionId },
      ),
    dueSnoozes: (now, limit) =>
      ids(
        "SELECT id FROM sessions WHERE snoozed_until IS NOT NULL AND snoozed_until <= $now ORDER BY snoozed_until LIMIT $limit",
        { now, limit },
      ),
    nextSnooze: () =>
      db.get<{ at: number | null }>(
        "SELECT min(snoozed_until) AS at FROM sessions WHERE snoozed_until IS NOT NULL",
      )?.at ?? null,
    settleCandidates: (cutoff, limit) =>
      ids(
        "SELECT id FROM sessions WHERE archived_at IS NULL AND settled_at IS NULL AND pin_rank IS NULL AND snoozed_until IS NULL " +
          "AND updated_at < $cutoff AND (unsettled_at IS NULL OR unsettled_at < $cutoff) ORDER BY updated_at LIMIT $limit",
        { cutoff, limit },
      ),
  };
}
