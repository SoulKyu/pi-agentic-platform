import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A temporary name never equals a name a caller may pick: `~` is outside every name rule pap accepts for a stored file. */
export const PRIVATE_TMP_PREFIX = ".~tmp~";

/** A folder that should be a real folder is a link or something else. */
export class PrivateFolderError extends Error {
  readonly reason: "link" | "not_a_directory";
  constructor(reason: "link" | "not_a_directory") {
    super(`private folder refused (${reason})`);
    this.reason = reason;
  }
}

/** The folder exists, is a real folder (never a link) and is 0700; parents that are missing are made 0700 too. */
export function ensurePrivateFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  if (!stat.isDirectory()) throw new PrivateFolderError(stat.isSymbolicLink() ? "link" : "not_a_directory");
  if ((stat.mode & 0o077) !== 0) chmodSync(folder, 0o700);
}

/**
 * Writes `bytes` whole to a temporary name (`O_EXCL|O_NOFOLLOW`, 0600), syncs it, then renames it over `path`: a rename
 * replaces a link at `path` instead of writing through it, and a reader never sees a partial file. The folder must exist.
 */
export function writePrivateFile(path: string, bytes: Uint8Array): void {
  const temporary = join(dirname(path), `${PRIVATE_TMP_PREFIX}${randomBytes(8).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Never made, or already renamed.
    }
    throw error;
  }
}
