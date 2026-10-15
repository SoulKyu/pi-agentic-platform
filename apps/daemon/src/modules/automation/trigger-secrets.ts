import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HOOK_SECRET } from "./hook-auth.ts";

const TRIGGER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Where the secrets of triggers live under `$PAP_HOME`. */
export const triggerSecretsDir = (home: string): string => join(home, "secrets", "triggers");

const fileOf = (dir: string, triggerId: string): string => {
  if (!TRIGGER_ID.test(triggerId)) throw new Error("bad trigger id");
  return join(dir, `${triggerId}.key`);
};

/** `$PAP_HOME/secrets/triggers/<id>.key`, 0600 in a 0700 folder, replaced atomically (C §3.1: never in the database). */
export function writeTriggerSecret(dir: string, triggerId: string, secret: string): void {
  if (!HOOK_SECRET.test(secret)) throw new Error("bad secret");
  const file = fileOf(dir, triggerId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, secret, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    // A failed replacement must not leave the new secret lying in a file nobody reads.
    rmSync(temp, { force: true });
    throw error;
  }
}

/** The secret, or null when the file is missing, is not a private regular file of ours, or does not hold one. Never follows a link. */
export function readTriggerSecret(dir: string, triggerId: string): string | null {
  let fd: number;
  try {
    fd = openSync(fileOf(dir, triggerId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 128)
      return null;
    const buffer = Buffer.alloc(128);
    const length = readSync(fd, buffer, 0, 128, 0);
    const secret = buffer.subarray(0, length).toString("utf8");
    return HOOK_SECRET.test(secret) ? secret : null;
  } finally {
    closeSync(fd);
  }
}

export function removeTriggerSecret(dir: string, triggerId: string): void {
  rmSync(fileOf(dir, triggerId), { force: true });
}
