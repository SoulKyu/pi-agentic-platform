import type { Db } from "../../kernel/db/database.ts";
import { cutUnits } from "../../kernel/text.ts";

export const MAX_ROW_CHARS = 16_384;

export interface FileCursor {
  readonly path: string;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** The byte the next read starts at: after the last complete line, or inside a line being skipped. */
  readonly offset: number;
  /** `offset` is inside a line over the line cap: the next read skips to its newline first (RT-23). */
  readonly skipLine: boolean;
  /** The first 512 characters of the header line: a rewrite in place changes them. */
  readonly head: string;
  readonly state: "indexed" | "excluded" | "bad" | "waiting";
  readonly sessionId: string | null;
  readonly ownerId: string | null;
  readonly indexedChars: number;
}

export interface IndexRow {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly at: number;
  readonly text: string;
}

// Controls (C0 and C1, tab and line feed kept) become spaces; format characters go, the emoji joiner kept (M4R46).
const CONTROLS = /[^\P{Cc}\t\n]/gu;
const FORMAT_EXCEPT_ZWJ = /(?!\u200D)\p{Cf}/gu;

/** Transcript text as it is indexed and later shown in a snippet. */
export const indexText = (raw: string): string =>
  cutUnits(raw.replace(CONTROLS, " ").replace(FORMAT_EXCEPT_ZWJ, ""), MAX_ROW_CHARS);

interface RawCursor extends Omit<FileCursor, "skipLine"> {
  skipLine: number;
}

const CURSOR_COLUMNS =
  "path, ino, size, mtime_ms AS mtimeMs, offset, skip_line AS skipLine, head, state, session_id AS sessionId, " +
  "owner_id AS ownerId, indexed_chars AS indexedChars";

const cursorOf = (raw: RawCursor): FileCursor => ({ ...raw, skipLine: raw.skipLine === 1 });

export interface SearchIndexStore {
  cursor(path: string): FileCursor | undefined;
  /** The cursors of the files directly in `dir`, by path, in one query (the reconcile, RT-26). */
  cursorsIn(dir: string): Map<string, FileCursor>;
  paths(): string[];
  /** A chunk's rows and the cursor after them, in one transaction (M4R48). Rows need a cursor that names a session. */
  commit(cursor: FileCursor, rows: readonly IndexRow[]): void;
  /** A file's rows (out of the FTS index too) and its cursor (M4R48). */
  forget(path: string): void;
  rowCount(): number;
}

export function createSearchIndexStore(db: Db): SearchIndexStore {
  return {
    cursor: (path) => {
      const raw = db.get<RawCursor>(`SELECT ${CURSOR_COLUMNS} FROM files WHERE path = $path`, { path });
      return raw ? cursorOf(raw) : undefined;
    },
    cursorsIn: (dir) =>
      new Map(
        db
          // "/" sorts just before "0": the range holds every path under `dir/`.
          .all<RawCursor>(`SELECT ${CURSOR_COLUMNS} FROM files WHERE path > $from AND path < $to`, {
            from: `${dir}/`,
            to: `${dir}0`,
          })
          .filter((raw) => !raw.path.slice(dir.length + 1).includes("/"))
          .map((raw) => [raw.path, cursorOf(raw)]),
      ),
    paths: () => db.all<{ path: string }>("SELECT path FROM files ORDER BY path").map((row) => row.path),
    commit: (cursor, rows) =>
      db.transaction(() => {
        if (rows.length > 0 && (cursor.sessionId === null || cursor.ownerId === null))
          throw new Error("index rows need a session and an owner");
        for (const row of rows) {
          const inserted = db.get<{ id: number }>(
            "INSERT INTO rows (path, session_id, owner_id, entry_id, role, at, text) VALUES ($path, $sessionId, $ownerId, $entryId, $role, $at, $text) RETURNING id",
            { path: cursor.path, sessionId: cursor.sessionId, ownerId: cursor.ownerId, ...row },
          );
          db.run("INSERT INTO rows_fts (rowid, text) VALUES ($id, $text)", {
            id: inserted?.id ?? null,
            text: row.text,
          });
        }
        db.run(
          "INSERT INTO files (path, ino, size, mtime_ms, offset, skip_line, head, state, session_id, owner_id, indexed_chars) " +
            "VALUES ($path, $ino, $size, $mtimeMs, $offset, $skipLine, $head, $state, $sessionId, $ownerId, $indexedChars) " +
            "ON CONFLICT (path) DO UPDATE SET ino = excluded.ino, size = excluded.size, mtime_ms = excluded.mtime_ms, " +
            "offset = excluded.offset, skip_line = excluded.skip_line, head = excluded.head, state = excluded.state, " +
            "session_id = excluded.session_id, owner_id = excluded.owner_id, indexed_chars = excluded.indexed_chars",
          { ...cursor, skipLine: cursor.skipLine ? 1 : 0 },
        );
      }),
    forget: (path) =>
      db.transaction(() => {
        for (const row of db.all<{ id: number; text: string }>(
          "SELECT id, text FROM rows WHERE path = $path",
          { path },
        ))
          db.run("INSERT INTO rows_fts (rows_fts, rowid, text) VALUES ('delete', $id, $text)", row);
        db.run("DELETE FROM rows WHERE path = $path", { path });
        db.run("DELETE FROM files WHERE path = $path", { path });
      }),
    rowCount: () => db.get<{ n: number }>("SELECT count(*) AS n FROM rows")?.n ?? 0,
  };
}
