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
}

export interface NewSession {
  readonly idHash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | null;
}

export interface AuthStore extends PasskeyStore {
  countUsers(): number;
  insertFirstUser(user: { id: string; username: string; passwordHash: string; createdAt: number }): boolean;
  findUserByName(username: string): UserRow | undefined;
  findUserById(id: string): UserRow | undefined;
  insertSession(session: NewSession): void;
  findSession(idHash: string): SessionRow | undefined;
  extendSession(idHash: string, lastSeenAt: number, expiresAt: number): void;
  deleteSession(idHash: string): void;
  deleteExpiredSessions(now: number): void;
}

const USER_COLUMNS = "id, username, password_hash AS passwordHash";

export function createAuthStore(db: Db): AuthStore {
  return {
    ...createPasskeyStore(db),
    countUsers: () => db.get<{ c: number }>("SELECT count(*) AS c FROM users")?.c ?? 0,
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
        "INSERT INTO auth_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES ($idHash, $userId, $createdAt, $lastSeenAt, $expiresAt, $userAgent)",
        { ...session },
      );
    },
    findSession: (idHash) =>
      db.get<SessionRow>(
        "SELECT s.id_hash AS idHash, s.user_id AS userId, u.username AS username, s.expires_at AS expiresAt FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $idHash",
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
  };
}
