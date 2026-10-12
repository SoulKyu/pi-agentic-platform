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
  "FROM rows_fts JOIN rows r ON r.id = rows_fts.rowid WHERE rows_fts MATCH $match AND r.owner_id = $owner AND pap_deadline() = 0" +
  ") SELECT id, sessionId, min(score) AS score FROM matched GROUP BY sessionId ORDER BY score, sessionId LIMIT $limit";

// The snippets of the chosen rows only.
const SNIPPETS =
  "SELECT rows_fts.rowid AS id, r.session_id AS sessionId, r.entry_id AS entryId, r.role AS role, r.at AS at, " +
  "snippet(rows_fts, 0, char(2), char(3), '…', 16) AS snippet " +
  "FROM rows_fts JOIN rows r ON r.id = rows_fts.rowid " +
  "WHERE rows_fts MATCH $match AND r.owner_id = $owner AND rows_fts.rowid IN (SELECT value FROM json_each($ids))";

/** The query ran past its deadline and was aborted from inside SQLite. */
export class QueryDeadlineError extends Error {
  constructor() {
    super("query deadline passed");
    this.name = "QueryDeadlineError";
  }
}

interface Prepared {
  readonly rank: StatementSync;
  readonly snippets: StatementSync;
  readonly state: { deadlineAt: number; now: () => number; expired: boolean };
}
const prepared = new WeakMap<DatabaseSync, Prepared>();

function prepare(db: DatabaseSync): Prepared {
  const state = { deadlineAt: Infinity, now: Date.now as () => number, expired: false };
  // worker.terminate() does not interrupt a running statement: the statement checks its own deadline per matched row.
  // FTS5's initial load of the match list happens before any row is filtered and is not bounded by this.
  db.function("pap_deadline", () => {
    if (state.now() < state.deadlineAt) return 0;
    state.expired = true;
    throw new QueryDeadlineError();
  });
  return { rank: db.prepare(RANK), snippets: db.prepare(SNIPPETS), state };
}

export function runQuery(
  db: DatabaseSync,
  input: QueryInput,
  deadline: { readonly at: number; readonly now?: () => number } = { at: Infinity },
): QueryRow[] {
  let statements = prepared.get(db);
  if (!statements) {
    statements = prepare(db);
    prepared.set(db, statements);
  }
  statements.state.deadlineAt = deadline.at;
  statements.state.now = deadline.now ?? Date.now;
  statements.state.expired = false;
  let ranked: Array<{ id: number }>;
  try {
    ranked = statements.rank.all({ match: input.match, owner: input.ownerId, limit: input.limit }) as Array<{
      id: number;
    }>;
  } catch (error) {
    if (statements.state.expired) throw new QueryDeadlineError();
    throw error;
  }
  const found = statements.snippets.all({
    match: input.match,
    owner: input.ownerId,
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
