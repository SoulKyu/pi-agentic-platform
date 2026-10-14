import { rmSync, statSync } from "node:fs";
import { type Db, openDatabase } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { isDamagedCode } from "./sqlite-codes.ts";

/** Bump to drop and rebuild: the index is a cache over Pi's files, never a source (ADR 0013). */
export const SEARCH_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  ino INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  offset INTEGER NOT NULL,
  skip_line INTEGER NOT NULL DEFAULT 0 CHECK (skip_line IN (0, 1)),
  head TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('indexed', 'excluded', 'bad', 'waiting')),
  session_id TEXT,
  owner_id TEXT,
  indexed_chars INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS rows (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  at INTEGER NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS rows_path ON rows(path);
CREATE INDEX IF NOT EXISTS rows_owner_session ON rows(owner_id, session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS rows_fts USING fts5(
  text, content='rows', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
`;

const DAMAGED_MESSAGE =
  /database disk image is malformed|file is not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i;

/** SQLite says the file is damaged (M4R44): primary code 11 (CORRUPT, extended codes too) or 26 (NOTADB). */
export function isIndexDamaged(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") return isDamagedCode(errcode);
  return error instanceof Error && DAMAGED_MESSAGE.test(error.message);
}

export function removeIndexFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/** The index's size on disk, its write-ahead log included (owner Q14). */
export function indexBytes(path: string): number {
  return ["", "-wal"].reduce(
    (total, suffix) => total + (statSync(`${path}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
    0,
  );
}

const closeQuietly = (db: Db, logger: Logger): void => {
  try {
    db.close();
  } catch (error) {
    logger.debug("search_index_close_failed", { err: error });
  }
};

function versionOf(db: Db): number | null {
  const hasMeta = db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  if (!hasMeta) return null;
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  return row ? Number(row.value) : null;
}

function prepare(db: Db): Db {
  // A cache: WAL stays consistent and a lost commit is rescanned, so no fsync per scanner step (M4R44, RT-21).
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', $value)", {
    value: String(SEARCH_SCHEMA_VERSION),
  });
  return db;
}

/** `$PAP_HOME/search.db`, rebuilt when it is another version or damaged (M4R44). */
export function openSearchIndex(path: string, logger: Logger): Db {
  let db: Db | null = null;
  try {
    db = openDatabase(path, { logger });
    const version = versionOf(db);
    if (version === null || version === SEARCH_SCHEMA_VERSION) return prepare(db);
    closeQuietly(db, logger);
    removeIndexFiles(path);
    logger.warn("search_index_rebuilt", { reason: "version", from: version });
    return prepare(openDatabase(path, { logger }));
  } catch (error) {
    if (!isIndexDamaged(error)) throw error;
    if (db) closeQuietly(db, logger);
    removeIndexFiles(path);
    logger.warn("search_index_rebuilt", { reason: "damaged" });
    return prepare(openDatabase(path, { logger }));
  }
}
