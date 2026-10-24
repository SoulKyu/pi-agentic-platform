import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, readFileSync, writeSync } from "node:fs";
import { closeQuietly, openAt, openDirAt, openRootDir, renameAt, unlinkAt } from "../../nofollow.ts";

const READ_MAX = 1024 * 1024;

/** The bytes of the home's regular file `name`; null when it is missing, a link, not a file or too large. */
export function readHomeFile(home: string, name: string): Buffer | null {
  const homeFd = openRootDir(home);
  try {
    let fd: number;
    try {
      fd = openAt(homeFd, name, constants.O_RDONLY);
    } catch {
      return null;
    }
    try {
      return fstatSync(fd).size > READ_MAX ? null : readFileSync(fd);
    } finally {
      closeQuietly(fd);
    }
  } finally {
    closeSync(homeFd);
  }
}

/**
 * Writes `name` (in the home, or in its folder `folder`) as guest root without following anything a session planted: a
 * temporary file made exclusively beside it, then renamed over it (a link at `name` is replaced, never written through).
 * A link or file in place of `folder` is refused.
 */
export function writeHomeFile(
  home: string,
  folder: string | null,
  name: string,
  content: string | Buffer,
  mode: number,
): void {
  const homeFd = openRootDir(home);
  let dirFd = homeFd;
  try {
    if (folder !== null) dirFd = openDirAt(homeFd, folder, { create: 0o755 });
    const temporary = `.${name}.pap-${randomBytes(6).toString("hex")}`;
    const fd = openAt(dirFd, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
      const bytes = Buffer.from(content);
      for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done);
    } catch (error) {
      closeQuietly(fd);
      unlinkAt(dirFd, temporary);
      throw error;
    }
    closeSync(fd);
    try {
      renameAt(dirFd, temporary, name);
    } catch (error) {
      unlinkAt(dirFd, temporary);
      throw error;
    }
  } finally {
    if (dirFd !== homeFd) closeQuietly(dirFd);
    closeSync(homeFd);
  }
}

/** Removes the home's file `name` (in `folder`); a link in place of it goes itself, and a link in place of `folder` is refused. */
export function removeHomeFile(home: string, folder: string, name: string): void {
  const homeFd = openRootDir(home);
  try {
    let dirFd: number;
    try {
      dirFd = openDirAt(homeFd, folder);
    } catch {
      return;
    }
    try {
      unlinkAt(dirFd, name);
    } catch {
      // Already gone.
    } finally {
      closeQuietly(dirFd);
    }
  } finally {
    closeSync(homeFd);
  }
}
