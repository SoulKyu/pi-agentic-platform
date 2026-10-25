import type { Role } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";
import { createPasskeyStore, passkeyRefOf, type PasskeyStore } from "./passkey-store.ts";

export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly disabledAt: number | null;
}

/** A user as the owner's list reads it. */
export interface AuthUserRow {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly disabledAt: number | null;
  readonly budgetUsd: number | null;
}

export interface SessionRow {
  readonly idHash: string;
  readonly userId: string;
  readonly username: string;
  readonly expiresAt: number;
  readonly publicId: string;
  readonly role: Role;
  readonly disabledAt: number | null;
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
  /** The instance owner: the one user whose role is owner (M14). */
  ownerId(): string | null;
  insertFirstUser(user: { id: string; username: string; passwordHash: string; createdAt: number }): boolean;
  /** A member with the install's default daily budget; false when the username is taken. */
  insertMember(user: { id: string; username: string; passwordHash: string; createdAt: number }): boolean;
  setPasswordHash(userId: string, passwordHash: string): void;
  userIds(): string[];
  listUsers(): AuthUserRow[];
  setDisabledAt(userId: string, disabledAt: number | null): void;
  /** The flag, the user's sessions and the user's tokens in one transaction; the id hashes of the sessions deleted. */
  disableAndRevoke(userId: string, at: number): string[];
  setBudget(userId: string, usd: number | null): void;
  budgetOf(userId: string): number | null;
  touchLastSeen(userId: string, at: number): void;
  deleteUser(userId: string): void;
  /** Every browser session of the user, expired or not; the id hashes of the rows deleted. */
  deleteSessionsOfUser(userId: string): string[];
  findUserByName(username: string): UserRow | undefined;
  findUserById(id: string): UserRow | undefined;
  insertSession(session: NewSession): void;
  findSession(idHash: string): SessionRow | undefined;
  extendSession(idHash: string, lastSeenAt: number, expiresAt: number): void;
  deleteSession(idHash: string): void;
  deleteExpiredSessions(now: number): void;
  /** Whether the user's browser session with this public id exists and has not expired; reads only. */
  sessionLive(userId: string, publicId: string, now: number): boolean;
  /** Newest first, at most `limit`. */
  listDevices(userId: string, limit: number): DeviceRow[];
  /** Live rows only; the id hashes of the rows deleted: the caller drops whatever it keeps by them. */
  deleteDevice(userId: string, publicId: string, now: number): string[];
  deleteOtherDevices(userId: string, keepPublicId: string, now: number): string[];
  /**
   * Deletes the user's passkey whose short id is `passkeyRef` and every browser session it opened, in one
   * transaction. Null when the user has no such passkey. `sessions` holds the id hashes of all those rows,
   * expired or not (an expired one is gone too); `live` counts the ones still valid at `now`.
   */
  deletePasskeyAndSessions(
    userId: string,
    passkeyRef: string,
    now: number,
  ): { sessions: string[]; live: number } | null;
}

const USER_COLUMNS = "id, username, password_hash AS passwordHash, role, disabled_at AS disabledAt";
export const DEFAULT_MEMBER_BUDGET_USD = 5;

export function createAuthStore(db: Db): AuthStore {
  const passkeys = createPasskeyStore(db);
  return {
    ...passkeys,
    countUsers: () => db.get<{ c: number }>("SELECT count(*) AS c FROM users")?.c ?? 0,
    ownerId: () => db.get<{ id: string }>("SELECT id FROM users WHERE role = 'owner'")?.id ?? null,
    insertFirstUser: (user) =>
      db.run(
        "INSERT INTO users (id, username, password_hash, created_at, role) SELECT $id, $username, $passwordHash, $createdAt, 'owner' WHERE NOT EXISTS (SELECT 1 FROM users)",
        user,
      ).changes === 1,
    insertMember: (user) =>
      db.run(
        "INSERT OR IGNORE INTO users (id, username, password_hash, created_at, role, budget_usd) VALUES ($id, $username, $passwordHash, $createdAt, 'member', $budget)",
        { ...user, budget: DEFAULT_MEMBER_BUDGET_USD },
      ).changes === 1,
    userIds: () => db.all<{ id: string }>("SELECT id FROM users ORDER BY created_at, id").map((r) => r.id),
    listUsers: () =>
      db.all<AuthUserRow>(
        "SELECT id, username, role, created_at AS createdAt, last_seen_at AS lastSeenAt, disabled_at AS disabledAt, budget_usd AS budgetUsd FROM users ORDER BY created_at, id",
      ),
    setDisabledAt: (userId, disabledAt) => {
      db.run("UPDATE users SET disabled_at = $disabledAt WHERE id = $userId", { userId, disabledAt });
    },
    disableAndRevoke: (userId, at) =>
      db.transaction(() => {
        db.run("UPDATE users SET disabled_at = $at WHERE id = $userId", { userId, at });
        db.run("DELETE FROM api_tokens WHERE user_id = $userId", { userId });
        return db
          .all<{ idHash: string }>(
            "DELETE FROM auth_sessions WHERE user_id = $userId RETURNING id_hash AS idHash",
            { userId },
          )
          .map((row) => row.idHash);
      }),
    setBudget: (userId, usd) => {
      db.run("UPDATE users SET budget_usd = $usd WHERE id = $userId", { userId, usd });
    },
    budgetOf: (userId) =>
      db.get<{ budget: number | null }>("SELECT budget_usd AS budget FROM users WHERE id = $userId", {
        userId,
      })?.budget ?? null,
    touchLastSeen: (userId, at) => {
      db.run("UPDATE users SET last_seen_at = $at WHERE id = $userId", { userId, at });
    },
    deleteUser: (userId) => {
      db.run("DELETE FROM users WHERE id = $userId", { userId });
    },
    setPasswordHash: (userId, passwordHash) => {
      db.run("UPDATE users SET password_hash = $passwordHash WHERE id = $userId", { userId, passwordHash });
    },
    deleteSessionsOfUser: (userId) =>
      db
        .all<{ idHash: string }>(
          "DELETE FROM auth_sessions WHERE user_id = $userId RETURNING id_hash AS idHash",
          {
            userId,
          },
        )
        .map((row) => row.idHash),
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
        "SELECT s.id_hash AS idHash, s.user_id AS userId, u.username AS username, s.expires_at AS expiresAt, s.public_id AS publicId, u.role AS role, u.disabled_at AS disabledAt FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $idHash",
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
    sessionLive: (userId, publicId, now) =>
      db.get(
        "SELECT 1 AS live FROM auth_sessions WHERE user_id = $userId AND public_id = $publicId AND expires_at > $now",
        { userId, publicId, now },
      ) !== undefined,
    listDevices: (userId, limit) =>
      db.all<DeviceRow>(
        "SELECT public_id AS publicId, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, user_agent AS userAgent, ip, method FROM auth_sessions WHERE user_id = $userId ORDER BY created_at DESC, rowid DESC LIMIT $limit",
        { userId, limit },
      ),
    deleteDevice: (userId, publicId, now) =>
      db
        .all<{ idHash: string }>(
          "DELETE FROM auth_sessions WHERE user_id = $userId AND public_id = $publicId AND expires_at > $now RETURNING id_hash AS idHash",
          { userId, publicId, now },
        )
        .map((row) => row.idHash),
    deleteOtherDevices: (userId, keepPublicId, now) =>
      db
        .all<{ idHash: string }>(
          "DELETE FROM auth_sessions WHERE user_id = $userId AND public_id <> $keepPublicId AND expires_at > $now RETURNING id_hash AS idHash",
          { userId, keepPublicId, now },
        )
        .map((row) => row.idHash),
    deletePasskeyAndSessions: (userId, passkeyRef, now) =>
      db.transaction(() => {
        const passkey = passkeys
          .listPasskeys(userId)
          .find((candidate) => passkeyRefOf(candidate.id) === passkeyRef);
        if (!passkey) return null;
        db.run("DELETE FROM passkeys WHERE user_id = $userId AND id = $id", { userId, id: passkey.id });
        const gone = db.all<{ idHash: string; expiresAt: number }>(
          "DELETE FROM auth_sessions WHERE user_id = $userId AND passkey_ref = $passkeyRef RETURNING id_hash AS idHash, expires_at AS expiresAt",
          { userId, passkeyRef },
        );
        return {
          sessions: gone.map((row) => row.idHash),
          live: gone.filter((row) => row.expiresAt > now).length,
        };
      }),
  };
}
