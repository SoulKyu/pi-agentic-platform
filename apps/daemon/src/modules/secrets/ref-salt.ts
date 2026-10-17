import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const SALT_BYTES = 32;

/** The code only: no path, no byte of the salt reaches an error. */
const unreadable = (): Error => new Error("ref_salt_unreadable");

/** A private regular file of ours, exactly 32 bytes, read without following a link; null when missing. */
function readSalt(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unreadable();
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size !== SALT_BYTES
    )
      throw unreadable();
    const buffer = Buffer.alloc(SALT_BYTES);
    let read = 0;
    while (read < SALT_BYTES) {
      const n = readSync(fd, buffer, read, SALT_BYTES - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read !== SALT_BYTES) throw unreadable();
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function syncFolder(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * `$PAP_HOME/secrets/vault/ref-salt` (M11R104): 32 random bytes, 0600, made once and never replaced. Made as a complete file
 * or not at all: a temporary file (`wx`, 0600) is written in full, synced, linked to its name (which fails if the name
 * exists) and removed, then the folder is synced, so a crash leaves no half salt. A salt that cannot be read as such
 * (wrong size, loose mode, a link) throws `ref_salt_unreadable`: refs are never made from a doubtful salt.
 */
export function loadRefSalt(vaultRoot: string): Buffer {
  const path = join(vaultRoot, "ref-salt");
  const existing = readSalt(path);
  if (existing !== null) return existing;
  mkdirSync(vaultRoot, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const salt = randomBytes(SALT_BYTES);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      let written = 0;
      while (written < salt.length) {
        const n = writeSync(fd, salt, written, salt.length - written);
        if (n <= 0) throw Object.assign(new Error("short write"), { code: "EIO" });
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } catch (error) {
      // Another writer made it first: read what is there.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
  syncFolder(vaultRoot);
  const made = readSalt(path);
  if (made === null) throw unreadable();
  return made;
}
