import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Logger } from "../logger.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, SqlValue>;

export interface Db {
  readonly readOnly: boolean;
  run(sql: string, params?: SqlParams): { changes: number };
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(path: string, options: { readOnly?: boolean; logger?: Logger } = {}): Db {
  const readOnly = options.readOnly === true;
  const raw = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
  // busy_timeout first: switching to WAL needs a lock and must wait for it like any other statement.
  raw.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  if (!readOnly) {
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA journal_size_limit = 33554432;");
  }
  const statements = new Map<string, StatementSync>();
  const prepared = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = raw.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  let depth = 0;
  return {
    readOnly,
    run: (sql, params = {}) => ({ changes: Number(prepared(sql).run(params).changes) }),
    get: <T>(sql: string, params: SqlParams = {}) => prepared(sql).get(params) as T | undefined,
    all: <T>(sql: string, params: SqlParams = {}) => prepared(sql).all(params) as T[],
    exec: (sql) => raw.exec(sql),
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          // The connection already dropped the transaction; the caller needs the original error.
        }
        throw error;
      } finally {
        depth--;
      }
    },
    close() {
      // SQLite checkpoints on the last close only: a reader still open (the search thread) would keep the log full.
      if (!readOnly) {
        try {
          raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (error) {
          // A reader in the middle of a read blocks the truncation; the log stays and SQLite recovers it at the next open.
          options.logger?.debug("wal_checkpoint_failed", { code: (error as { code?: unknown }).code });
        }
      }
      raw.close();
    },
  };
}
