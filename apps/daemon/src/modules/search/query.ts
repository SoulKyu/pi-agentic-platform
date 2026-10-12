import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface QueryInput {
  readonly match: string;
  readonly ownerId: string;
  readonly limit: number;
}

export interface QueryRow {
  readonly sessionId: string;
  readonly entryId: string;
  readonly role: string;
  readonly at: number;
  readonly snippet: string;
}

// The best row of each of the owner's sessions, best sessions first (M4R54): ranked in SQL, so one long session takes
// one place (RT-06). MATERIALIZED keeps bm25() inside the FTS query: SQLite refuses it once flattened into the GROUP BY.
const RANK =
  "WITH matched AS MATERIALIZED (" +
  "SELECT rows_fts.rowid AS id, r.session_id AS sessionId, bm25(rows_fts) AS score " +
  "FROM rows_fts JOIN rows r ON r.id = rows_fts.rowid WHERE rows_fts MATCH $match AND r.owner_id = $owner" +
  ") SELECT id, sessionId, min(score) AS score FROM matched GROUP BY sessionId ORDER BY score, sessionId LIMIT $limit";

// The snippets of the chosen rows only.
const SNIPPETS =
  "SELECT rows_fts.rowid AS id, r.session_id AS sessionId, r.entry_id AS entryId, r.role AS role, r.at AS at, " +
  "snippet(rows_fts, 0, char(2), char(3), '…', 16) AS snippet " +
  "FROM rows_fts JOIN rows r ON r.id = rows_fts.rowid " +
  "WHERE rows_fts MATCH $match AND rows_fts.rowid IN (SELECT value FROM json_each($ids))";

const prepared = new WeakMap<
  DatabaseSync,
  { readonly rank: StatementSync; readonly snippets: StatementSync }
>();

export function runQuery(db: DatabaseSync, input: QueryInput): QueryRow[] {
  let statements = prepared.get(db);
  if (!statements) {
    statements = { rank: db.prepare(RANK), snippets: db.prepare(SNIPPETS) };
    prepared.set(db, statements);
  }
  const ranked = statements.rank.all({
    match: input.match,
    owner: input.ownerId,
    limit: input.limit,
  }) as Array<{
    id: number;
  }>;
  if (ranked.length === 0) return [];
  const found = statements.snippets.all({
    match: input.match,
    ids: JSON.stringify(ranked.map((row) => row.id)),
  }) as unknown as Array<QueryRow & { readonly id: number }>;
  const byId = new Map(found.map((row) => [row.id, row]));
  return ranked.flatMap((row) => {
    const hit = byId.get(row.id);
    return hit
      ? [{ sessionId: hit.sessionId, entryId: hit.entryId, role: hit.role, at: hit.at, snippet: hit.snippet }]
      : [];
  });
}
