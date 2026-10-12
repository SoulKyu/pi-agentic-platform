import type { Db } from "../../kernel/db/database.ts";

export interface SessionRow {
  /** The session's own id: what the client and the stream use. Pi's id for the same session lives in `piSessionId`. */
  readonly id: string;
  /** Absolute path of Pi's file; null for a draft, a session Pi has not written a file for yet. */
  readonly piPath: string | null;
  /** The uuid in that file's header; null exactly when `piPath` is. */
  readonly piSessionId: string | null;
  readonly cwd: string;
  readonly ownerId: string;
  /** Pi's name for the session as the worker last said it (clipped by `nameOf`); null when it has none. */
  readonly name: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionsStore {
  insert(row: SessionRow): void;
  get(id: string): SessionRow | undefined;
  listByOwner(ownerId: string): SessionRow[];
  touch(id: string, at: number): void;
  /** Caches Pi's name for listings; the CHECK refuses what `nameOf` would not return. */
  setName(id: string, name: string | null): void;
  /** Sets the Pi file of a draft, once. False when the session already has one. Throws when another session owns the path. */
  bindPiFile(id: string, piPath: string, piSessionId: string): boolean;
  appendEvent(sessionId: string, kind: string, data: unknown, at: number): void;
}

const COLUMNS =
  "id, pi_path AS piPath, pi_session_id AS piSessionId, cwd, owner_id AS ownerId, name, created_at AS createdAt, updated_at AS updatedAt";

export function createSessionsStore(db: Db): SessionsStore {
  return {
    insert: (row) => {
      db.run(
        "INSERT INTO sessions (id, pi_path, pi_session_id, cwd, owner_id, name, created_at, updated_at) VALUES ($id, $piPath, $piSessionId, $cwd, $ownerId, $name, $createdAt, $updatedAt)",
        { ...row },
      );
    },
    get: (id) => db.get<SessionRow>(`SELECT ${COLUMNS} FROM sessions WHERE id = $id`, { id }),
    listByOwner: (ownerId) =>
      db.all<SessionRow>(
        `SELECT ${COLUMNS} FROM sessions WHERE owner_id = $ownerId ORDER BY updated_at DESC, id`,
        { ownerId },
      ),
    touch: (id, at) => {
      db.run("UPDATE sessions SET updated_at = $at WHERE id = $id", { id, at });
    },
    setName: (id, name) => {
      db.run("UPDATE sessions SET name = $name WHERE id = $id", { id, name });
    },
    bindPiFile: (id, piPath, piSessionId) =>
      db.run(
        "UPDATE sessions SET pi_path = $piPath, pi_session_id = $piSessionId WHERE id = $id AND pi_path IS NULL",
        { id, piPath, piSessionId },
      ).changes > 0,
    appendEvent: (sessionId, kind, data, at) => {
      db.run(
        "INSERT INTO session_events (session_id, kind, data, created_at) VALUES ($sessionId, $kind, $data, $at)",
        { sessionId, kind, data: JSON.stringify(data ?? null), at },
      );
    },
  };
}
