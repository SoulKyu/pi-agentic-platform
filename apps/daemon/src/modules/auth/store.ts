import type { Db } from "../../kernel/db/database.ts";
import { createPasskeyStore, type PasskeyStore } from "./passkey-store.ts";

export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
}

export interface SessionRow {
  readonly idHash: string;
  readonly userId: string;
  readonly username: string;
  readonly expiresAt: number;
  readonly publicId: string;
}

export type SignInMethod = "password" | "passkey" | "setup";

/** A browser session as the devices list reads it: the public id, never the cookie's hash. */
export interface DeviceRow {
  readonly publicId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly method: SignInMethod | null;
}

export interface NewSession {
  readonly idHash: string;
  readonly publicId: string;
  readonly ip: string | null;
  readonly method: SignInMethod | null;
  readonly passkeyRef: string | null;
  readonly userId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | null;
}

export interface AuthStore extends PasskeyStore {
  countUsers(): number;
  /** The oldest user: the instance owner (M4R61). */
  firstUserId(): string | null;
  insertFirstUser(user: { id: string; username: string; passwordHash: string; createdAt: number }): boolean;
  findUserByName(username: string): UserRow | undefined;
  findUserById(id: string): UserRow | undefined;
  insertSession(session: NewSession): void;
  findSession(idHash: string): SessionRow | undefined;
  extendSession(idHash: string, lastSeenAt: number, expiresAt: number): void;
  deleteSession(idHash: string): void;
  deleteExpiredSessions(now: number): void;
  /** Newest first, at most `limit`. */
  listDevices(userId: string, limit: number): DeviceRow[];
  /** The id hashes of the rows deleted: the caller drops whatever it keeps by them. */
  deleteDevice(userId: string, publicId: string): string[];
  deleteOtherDevices(userId: string, keepPublicId: string): string[];
}

const USER_COLUMNS = "id, username, password_hash AS passwordHash";

export function createAuthStore(db: Db): AuthStore {
  return {
    ...createPasskeyStore(db),
    countUsers: () => db.get<{ c: number }>("SELECT count(*) AS c FROM users")?.c ?? 0,
    firstUserId: () =>
      db.get<{ id: string }>("SELECT id FROM users ORDER BY created_at, id LIMIT 1")?.id ?? null,
    insertFirstUser: (user) =>
      db.run(
        "INSERT INTO users (id, username, password_hash, created_at) SELECT $id, $username, $passwordHash, $createdAt WHERE NOT EXISTS (SELECT 1 FROM users)",
        user,
      ).changes === 1,
    findUserByName: (username) =>
      db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE username = $username`, { username }),
    findUserById: (id) => db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $id`, { id }),
    insertSession: (session) => {
      db.run(
        "INSERT INTO auth_sessions (id_hash, public_id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, method, passkey_ref) VALUES ($idHash, $publicId, $userId, $createdAt, $lastSeenAt, $expiresAt, $userAgent, $ip, $method, $passkeyRef)",
        { ...session },
      );
    },
    findSession: (idHash) =>
      db.get<SessionRow>(
        "SELECT s.id_hash AS idHash, s.user_id AS userId, u.username AS username, s.expires_at AS expiresAt, s.public_id AS publicId FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $idHash",
        { idHash },
      ),
    extendSession: (idHash, lastSeenAt, expiresAt) => {
      db.run(
        "UPDATE auth_sessions SET last_seen_at = $lastSeenAt, expires_at = $expiresAt WHERE id_hash = $idHash",
        {
          idHash,
          lastSeenAt,
          expiresAt,
        },
      );
    },
    deleteSession: (idHash) => {
      db.run("DELETE FROM auth_sessions WHERE id_hash = $idHash", { idHash });
    },
    deleteExpiredSessions: (now) => {
      db.run("DELETE FROM auth_sessions WHERE expires_at <= $now", { now });
    },
    listDevices: (userId, limit) =>
      db.all<DeviceRow>(
        "SELECT public_id AS publicId, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, user_agent AS userAgent, ip, method FROM auth_sessions WHERE user_id = $userId ORDER BY created_at DESC, rowid DESC LIMIT $limit",
        { userId, limit },
      ),
    deleteDevice: (userId, publicId) =>
      db
        .all<{ idHash: string }>(
          "DELETE FROM auth_sessions WHERE user_id = $userId AND public_id = $publicId RETURNING id_hash AS idHash",
          { userId, publicId },
        )
        .map((row) => row.idHash),
    deleteOtherDevices: (userId, keepPublicId) =>
      db
        .all<{ idHash: string }>(
          "DELETE FROM auth_sessions WHERE user_id = $userId AND public_id <> $keepPublicId RETURNING id_hash AS idHash",
          { userId, keepPublicId },
        )
        .map((row) => row.idHash),
  };
}
