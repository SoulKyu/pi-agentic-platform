import { closeSync, constants, fchmodSync, mkdirSync, openSync, unlinkSync } from "node:fs";

/**
 * Descriptor-relative opens that never follow a link (R26, AVM-P7). A caller holds a folder's descriptor and names ONE
 * entry in it; the entry is opened through `/proc/self/fd/<fd>/<name>` with O_NOFOLLOW, so a link planted there is refused
 * (ELOOP or "not a folder") and a folder swapped for a link after the descriptor was opened changes nothing: the descriptor
 * still names the original folder. Linux only, like the VM and the process backend that use it.
 */

const SINGLE_NAME = /^[^/\0]+$/;
const FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function inside(dirFd: number, name: string): string {
  if (!SINGLE_NAME.test(name) || name === "." || name === "..") {
    throw new Error("expected a single name, not a path");
  }
  return `/proc/self/fd/${dirFd}/${name}`;
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Opens a folder by its own path; only the last component is checked for a link (the caller trusts the parents). */
export function openRootDir(path: string): number {
  return openSync(path, FOLDER);
}

/** Opens `name` inside the folder `dirFd`. O_NOFOLLOW is always added: a link as `name` is ELOOP. */
export function openAt(dirFd: number, name: string, flags: number, mode = 0o600): number {
  return openSync(inside(dirFd, name), flags | constants.O_NOFOLLOW, mode);
}

/**
 * Opens the folder `name` inside `dirFd`. With `create`, a missing one is made with that mode (an existing one keeps its
 * own). A link, a file or anything else in its place throws "<name> is not a folder".
 */
export function openDirAt(dirFd: number, name: string, options: { create?: number } = {}): number {
  const path = inside(dirFd, name);
  const notFolder = new Error(`${name} is not a folder`);
  const open = (): number => {
    try {
      return openSync(path, FOLDER);
    } catch (error) {
      if (codeOf(error) === "ELOOP" || codeOf(error) === "ENOTDIR") throw notFolder;
      throw error;
    }
  };
  try {
    return open();
  } catch (error) {
    if (codeOf(error) !== "ENOENT" || options.create === undefined) throw error;
  }
  try {
    mkdirSync(path, options.create);
  } catch (error) {
    // Lost a race to another maker, or a dangling link sits there: the open below tells which.
    if (codeOf(error) !== "EEXIST") throw error;
    return open();
  }
  const fd = open();
  fchmodSync(fd, options.create);
  return fd;
}

/** Removes the entry `name` of `dirFd`; a link is removed itself, never its target. */
export function unlinkAt(dirFd: number, name: string): void {
  unlinkSync(inside(dirFd, name));
}

export const closeQuietly = (fd: number): void => {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
};
