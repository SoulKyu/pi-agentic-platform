import type { Db } from "../../kernel/db/database.ts";

export interface InviteRow {
  readonly id: string;
  readonly createdBy: string;
  readonly nameHint: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface InviteStore {
  insert(row: InviteRow & { tokenHash: string }): void;
  /** The unused, unexpired invitation of this token hash, with its creator's username. */
  findLive(tokenHash: string, now: number): (InviteRow & { inviter: string }) | undefined;
  listLive(now: number): InviteRow[];
  /** Marks it used when it is still unused and unexpired; false when it is not (a concurrent accept won). */
  markUsed(tokenHash: string, now: number, usedBy: string): boolean;
  /** Deletes an unused invitation. */
  revoke(id: string): boolean;
}

const COLUMNS =
  "id, created_by AS createdBy, name_hint AS nameHint, created_at AS createdAt, expires_at AS expiresAt";

export function createInviteStore(db: Db): InviteStore {
  return {
    insert: (row) => {
      db.run(
        "INSERT INTO invitations (id, token_hash, created_by, name_hint, created_at, expires_at) VALUES ($id, $tokenHash, $createdBy, $nameHint, $createdAt, $expiresAt)",
        { ...row },
      );
    },
    findLive: (tokenHash, now) =>
      db.get(
        `SELECT i.id AS id, i.created_by AS createdBy, i.name_hint AS nameHint, i.created_at AS createdAt, i.expires_at AS expiresAt, u.username AS inviter FROM invitations i JOIN users u ON u.id = i.created_by WHERE i.token_hash = $tokenHash AND i.used_at IS NULL AND i.expires_at > $now`,
        { tokenHash, now },
      ),
    listLive: (now) =>
      db.all(
        `SELECT ${COLUMNS} FROM invitations WHERE used_at IS NULL AND expires_at > $now ORDER BY created_at, id`,
        { now },
      ),
    markUsed: (tokenHash, now, usedBy) =>
      db.run(
        "UPDATE invitations SET used_at = $now, used_by = $usedBy WHERE token_hash = $tokenHash AND used_at IS NULL AND expires_at > $now",
        { tokenHash, now, usedBy },
      ).changes === 1,
    revoke: (id) =>
      db.run("DELETE FROM invitations WHERE id = $id AND used_at IS NULL", { id }).changes === 1,
  };
}
