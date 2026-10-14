import type { Db } from "../../kernel/db/database.ts";

export interface ProjectRow {
  readonly id: string;
  readonly ownerId: string;
  readonly root: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
}

export interface ProjectsStore {
  byRoot(ownerId: string, root: string): ProjectRow | undefined;
  get(ownerId: string, id: string): ProjectRow | undefined;
  /** In the person's order. */
  list(ownerId: string): ProjectRow[];
  byIds(ownerId: string, ids: readonly string[]): ProjectRow[];
  /** Every root of the owner, newest first (M8R19). */
  roots(ownerId: string): string[];
  count(ownerId: string): number;
  /** The lowest position, null without projects. */
  firstPosition(ownerId: string): number | null;
  insert(row: ProjectRow): void;
  rename(ownerId: string, id: string, name: string): void;
  setPosition(ownerId: string, id: string, position: number): void;
  /** Positions 1..n in this order, in one transaction. */
  renumber(ownerId: string, orderedIds: readonly string[]): void;
}

const COLUMNS = "id, owner_id AS ownerId, root, name, position, created_at AS createdAt";

export function createProjectsStore(db: Db): ProjectsStore {
  const setPosition = (ownerId: string, id: string, position: number) => {
    db.run("UPDATE projects SET position = $position WHERE owner_id = $ownerId AND id = $id", {
      ownerId,
      id,
      position,
    });
  };
  return {
    byRoot: (ownerId, root) =>
      db.get<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId AND root = $root`, {
        ownerId,
        root,
      }),
    get: (ownerId, id) =>
      db.get<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId AND id = $id`, {
        ownerId,
        id,
      }),
    list: (ownerId) =>
      db.all<ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId ORDER BY position, id`, {
        ownerId,
      }),
    byIds: (ownerId, ids) =>
      ids.length === 0
        ? []
        : db.all<ProjectRow>(
            `SELECT ${COLUMNS} FROM projects WHERE owner_id = $ownerId AND id IN (SELECT value FROM json_each($ids)) ORDER BY position, id`,
            { ownerId, ids: JSON.stringify(ids) },
          ),
    roots: (ownerId) =>
      db
        .all<{ root: string }>(
          "SELECT root FROM projects WHERE owner_id = $ownerId ORDER BY created_at DESC, id DESC LIMIT 2000",
          { ownerId },
        )
        .map((row) => row.root),
    count: (ownerId) =>
      db.get<{ n: number }>("SELECT count(*) AS n FROM projects WHERE owner_id = $ownerId", { ownerId })?.n ??
      0,
    firstPosition: (ownerId) =>
      db.get<{ p: number | null }>("SELECT min(position) AS p FROM projects WHERE owner_id = $ownerId", {
        ownerId,
      })?.p ?? null,
    insert: (row) => {
      db.run(
        "INSERT INTO projects (id, owner_id, root, name, position, created_at) VALUES ($id, $ownerId, $root, $name, $position, $createdAt)",
        { ...row },
      );
    },
    rename: (ownerId, id, name) => {
      db.run("UPDATE projects SET name = $name WHERE owner_id = $ownerId AND id = $id", {
        ownerId,
        id,
        name,
      });
    },
    setPosition,
    renumber: (ownerId, orderedIds) =>
      db.transaction(() => orderedIds.forEach((id, index) => setPosition(ownerId, id, index + 1))),
  };
}
