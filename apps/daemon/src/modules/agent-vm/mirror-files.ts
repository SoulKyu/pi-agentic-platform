import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";

/** A mirror is daemon-private: 0600 files in 0700 folders (R23). */
export const FILE_MODE = 0o600;
export const FOLDER_MODE = 0o700;

const mine = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

/**
 * A folder of the mirrors: created 0700 when missing, and never a link, a file or another user's folder. `vmGate` makes
 * `.mirrors/<id>/`; a folder that appeared since (a link planted by the agent's host shell) refuses here.
 */
export function ensureFolder(folder: string): void {
  let found;
  try {
    found = lstatSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(folder, { recursive: true, mode: FOLDER_MODE });
    found = lstatSync(folder);
  }
  if (found.isSymbolicLink() || !found.isDirectory() || !mine(found.uid))
    throw new Error("mirror folder refused");
}

/**
 * Opens a file of the mirrors without following a link (O_NOFOLLOW), 0600 when it is created, and refuses what is not one
 * regular file of this user with no other name (a hard link could point at a file the daemon must not write).
 */
export function openPrivate(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, FILE_MODE);
  try {
    const found = fstatSync(fd);
    if (!found.isFile() || found.nlink !== 1 || !mine(found.uid)) throw new Error("mirror file refused");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Whether something (a link included) is at `path`. */
export function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
