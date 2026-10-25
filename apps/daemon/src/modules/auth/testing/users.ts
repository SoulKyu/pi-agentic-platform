import type { Role } from "@pap/contracts";
import type { Db } from "../../../kernel/db/database.ts";

/** Raw user rows for beds and tests: the role is always explicit, because the column defaults to member. */
export function insertUserRow(
  db: Db,
  user: { id: string; username?: string; role?: Role; createdAt?: number; passwordHash?: string },
): void {
  db.run(
    "INSERT INTO users (id, username, password_hash, created_at, role) VALUES ($id, $username, $passwordHash, $createdAt, $role)",
    {
      id: user.id,
      username: user.username ?? user.id,
      passwordHash: user.passwordHash ?? "x",
      createdAt: user.createdAt ?? 0,
      role: user.role ?? "member",
    },
  );
}
