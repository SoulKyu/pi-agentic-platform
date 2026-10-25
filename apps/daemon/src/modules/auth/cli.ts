import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "@pap/contracts";
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

/** The owner's user id, or null before the first user exists. */
export const ownerIdOf = (db: Db): string | null => createAuthStore(db).ownerId();

/** Whether an owner exists. */
export const hasOwner = (db: Db): boolean => createAuthStore(db).ownerId() !== null;

/**
 * `pap user add`: the owner while no user exists, a member after. `role` asks for one explicitly: "owner" is refused
 * once an owner exists, and "member" is refused before it (a member alone would end the setup with no owner).
 */
export async function createUserFromCli(
  db: Db,
  clock: Clock,
  audit: Pick<AuditPort, "append">,
  input: { readonly username: string; readonly password: string; readonly role?: Role },
): Promise<Role> {
  const store = createAuthStore(db);
  if (!USERNAME_PATTERN.test(input.username))
    throw new AuthCliError("the username may use letters, digits, . _ - and 64 characters at most");
  const first = store.countUsers() === 0;
  if (input.role === "owner" && !first) throw new AuthCliError("an owner already exists");
  if (input.role === "member" && first) throw new AuthCliError("no owner yet: add the owner first");
  if (!isAcceptablePassword(input.password)) throw new AuthCliError(BAD_PASSWORD);
  const id = newId();
  const passwordHash = await hashPassword(input.password);
  const user = { id, username: input.username, passwordHash, createdAt: clock.now() };
  if (first) {
    // `INSERT … WHERE NOT EXISTS (SELECT 1 FROM users)`: two owners cannot appear, whatever ran in between.
    if (!store.insertFirstUser(user)) throw new AuthCliError("an owner already exists");
    audit.append({ ownerId: id, actor: "cli", kind: "auth", reason: "owner_created" });
    return "owner";
  }
  if (!store.insertMember(user)) throw new AuthCliError("this username is taken");
  audit.append({ ownerId: id, actor: "cli", kind: "auth", reason: "member_created" });
  return "member";
}

/**
 * `pap passkey reset [<username>]`: signs one user (the owner by default) out everywhere. Every passkey and browser
 * session of that user go, and the known-device key (M5R82, install-wide) only for the owner, in one transaction (the key file is removed inside it: a failure rolls the rows back); tokens only with
 * `revokeTokens`; the password changes only when `newPassword` is given. The new password is checked before anything
 * is deleted. Writes one audit line with the counts and no secret.
 */
export async function resetCredentials(
  db: Db,
  audit: Pick<AuditPort, "append">,
  home: string,
  options: { readonly revokeTokens: boolean; readonly newPassword?: string; readonly username?: string },
): Promise<{ passkeys: number; sessions: number; tokens: number }> {
  const store = createAuthStore(db);
  const tokenStore = createTokenStore(db, silentLogger);
  const ownerId = store.ownerId();
  if (ownerId === null) throw new AuthCliError("no owner yet: run pap user add first");
  const target = options.username === undefined ? { id: ownerId } : store.findUserByName(options.username);
  if (!target) throw new AuthCliError(`no user named ${options.username}`);
  if (options.newPassword !== undefined && !isAcceptablePassword(options.newPassword))
    throw new AuthCliError(BAD_PASSWORD);
  const passwordHash =
    options.newPassword === undefined ? undefined : await hashPassword(options.newPassword);
  // The audit line is written in the same transaction (the audit module shares the database): a failure rolls the whole
  // reset back, so a committed reset always has its line. The key file goes last, just before the commit.
  return db.transaction(() => {
    const passkeys = store.deleteAllPasskeys(target.id);
    const sessions = store.deleteSessionsOfUser(target.id).length;
    const tokens = options.revokeTokens ? tokenStore.deleteAllOf(target.id) : 0;
    if (passwordHash !== undefined) store.setPasswordHash(target.id, passwordHash);
    const counts = { passkeys, sessions, tokens };
    audit.append({
      ownerId: target.id,
      actor: "cli",
      kind: "auth",
      reason: "credentials_reset",
      detail: { ...counts, passwordChanged: passwordHash !== undefined },
    });
    if (target.id === ownerId) rmSync(join(home, "secrets", "device.key"), { force: true });
    return counts;
  });
}
