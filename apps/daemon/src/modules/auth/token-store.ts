import type { Permission } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";

export interface TokenRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly hint: string;
  readonly secretHash: string;
  readonly permissions: readonly Permission[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
}

export interface TokenStore {
  insert(row: TokenRow): void;
  count(userId: string): number;
  findByHash(secretHash: string): TokenRow | undefined;
  touch(id: string, at: number): void;
  list(userId: string): TokenRow[];
  /** Deletes the owner's expired tokens and returns their ids. */
  deleteExpired(userId: string, now: number): string[];
  delete(userId: string, id: string): boolean;
}

interface RawRow extends Omit<TokenRow, "permissions"> {
  readonly permissions: string;
}

const COLUMNS =
  "id, user_id AS userId, name, hint, secret_hash AS secretHash, permissions, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt";

const MAX_LOGGED_IDS = 100;

// A stored list that is not a JSON array of strings reads as empty: a damaged row grants nothing.
function parsePermissions(text: string): Permission[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value.filter((p) => typeof p === "string") as Permission[]) : null;
  } catch {
    return null;
  }
}

export function createTokenStore(db: Db, logger: Logger): TokenStore {
  // One warn line per damaged token (its id only, never the value or the hash); the set is capped.
  const logged = new Set<string>();
  const rowOf = (raw: RawRow): TokenRow => {
    const permissions = parsePermissions(raw.permissions);
    if (permissions === null && !logged.has(raw.id)) {
      if (logged.size >= MAX_LOGGED_IDS) logged.clear();
      logged.add(raw.id);
      logger.warn("token_row_damaged", { rowId: raw.id });
    }
    return { ...raw, permissions: permissions ?? [] };
  };
  return {
    insert: (row) => {
      db.run(
        "INSERT INTO api_tokens (id, user_id, name, hint, secret_hash, permissions, created_at, expires_at, last_used_at) VALUES ($id, $userId, $name, $hint, $secretHash, $permissions, $createdAt, $expiresAt, $lastUsedAt)",
        { ...row, permissions: JSON.stringify(row.permissions) },
      );
    },
    count: (userId) =>
      db.get<{ c: number }>("SELECT count(*) AS c FROM api_tokens WHERE user_id = $userId", { userId })?.c ??
      0,
    findByHash: (secretHash) => {
      const raw = db.get<RawRow>(`SELECT ${COLUMNS} FROM api_tokens WHERE secret_hash = $secretHash`, {
        secretHash,
      });
      return raw ? rowOf(raw) : undefined;
    },
    touch: (id, at) => {
      db.run("UPDATE api_tokens SET last_used_at = $at WHERE id = $id", { id, at });
    },
    list: (userId) =>
      db
        .all<RawRow>(`SELECT ${COLUMNS} FROM api_tokens WHERE user_id = $userId ORDER BY created_at, id`, {
          userId,
        })
        .map(rowOf),
    deleteExpired: (userId, now) =>
      db
        .all<{ id: string }>(
          "DELETE FROM api_tokens WHERE user_id = $userId AND expires_at <= $now RETURNING id",
          { userId, now },
        )
        .map((row) => row.id),
    delete: (userId, id) =>
      db.run("DELETE FROM api_tokens WHERE user_id = $userId AND id = $id", { userId, id }).changes === 1,
  };
}
