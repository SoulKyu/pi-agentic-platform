import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { newId } from "../../kernel/ids.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { hashPassword, isAcceptablePassword } from "./passwords.ts";
import { USERNAME_PATTERN } from "./service.ts";
import { createAuthStore } from "./store.ts";
import { createTokenStore } from "./token-store.ts";

/** A refusal of an admin command, with a fixed message the CLI prints as it is. */
export class AuthCliError extends Error {
  override name = "AuthCliError";
}

const BAD_PASSWORD = "the password needs 12 to 1024 characters";

export const isValidUsername = (username: string): boolean => USERNAME_PATTERN.test(username);

/** Whether an owner exists (the oldest user is the instance owner). */
export const hasOwner = (db: Db): boolean => createAuthStore(db).countUsers() > 0;

/** `pap user add`: the owner, created the way `/auth/setup` creates it. Never a second user. */
export async function createOwnerFromCli(
  db: Db,
  clock: Clock,
  audit: Pick<AuditPort, "append">,
  input: { readonly username: string; readonly password: string },
): Promise<void> {
  const store = createAuthStore(db);
  if (!USERNAME_PATTERN.test(input.username))
    throw new AuthCliError("the username may use letters, digits, . _ - and 64 characters at most");
  if (store.countUsers() > 0) throw new AuthCliError("an owner already exists: pap v1 has one owner");
  if (!isAcceptablePassword(input.password)) throw new AuthCliError(BAD_PASSWORD);
  const id = newId();
  const passwordHash = await hashPassword(input.password);
  // `INSERT … WHERE NOT EXISTS (SELECT 1 FROM users)`: a second user cannot appear, whatever ran in between.
  if (!store.insertFirstUser({ id, username: input.username, passwordHash, createdAt: clock.now() }))
    throw new AuthCliError("an owner already exists: pap v1 has one owner");
  audit.append({ ownerId: id, actor: "cli", kind: "auth", reason: "owner_created" });
}

/**
 * `pap passkey reset`: signs the owner out everywhere. Every passkey, every browser session and the known-device key
 * (M5R82) go, in one transaction (the key file is removed inside it: a failure rolls the rows back); tokens only with
 * `revokeTokens`; the password changes only when `newPassword` is given. The new password is checked before anything
 * is deleted. Writes one audit line with the counts and no secret.
 */
export async function resetCredentials(
  db: Db,
  audit: Pick<AuditPort, "append">,
  home: string,
  options: { readonly revokeTokens: boolean; readonly newPassword?: string },
): Promise<{ passkeys: number; sessions: number; tokens: number }> {
  const store = createAuthStore(db);
  const tokenStore = createTokenStore(db, silentLogger);
  const ownerId = store.oldestUserId();
  if (ownerId === undefined) throw new AuthCliError("no owner yet: run pap user add first");
  if (options.newPassword !== undefined && !isAcceptablePassword(options.newPassword))
    throw new AuthCliError(BAD_PASSWORD);
  const passwordHash =
    options.newPassword === undefined ? undefined : await hashPassword(options.newPassword);
  // The audit line is written in the same transaction (the audit module shares the database): a failure rolls the whole
  // reset back, so a committed reset always has its line. The key file goes last, just before the commit.
  return db.transaction(() => {
    const passkeys = store.deleteAllPasskeys();
    const sessions = store.deleteAllSessions();
    const tokens = options.revokeTokens ? tokenStore.deleteAll() : 0;
    if (passwordHash !== undefined) store.setPasswordHash(ownerId, passwordHash);
    const counts = { passkeys, sessions, tokens };
    audit.append({
      ownerId,
      actor: "cli",
      kind: "auth",
      reason: "credentials_reset",
      detail: { ...counts, passwordChanged: passwordHash !== undefined },
    });
    rmSync(join(home, "secrets", "device.key"), { force: true });
    return counts;
  });
}
