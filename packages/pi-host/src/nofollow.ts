import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";

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

/**
 * Opens `name` inside the folder `dirFd`. O_NOFOLLOW is always added (a link as `name` is ELOOP) and so is O_NONBLOCK, and
 * anything that is not a regular file is closed and refused, so a planted FIFO or device cannot block or feed the caller.
 */
export function openAt(dirFd: number, name: string, flags: number, mode = 0o600): number {
  const fd = openSync(inside(dirFd, name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${name} is not a regular file`);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/** Renames `from` to `to`, both entries of the folder `dirFd`. */
export function renameAt(dirFd: number, from: string, to: string): void {
  renameSync(inside(dirFd, from), inside(dirFd, to));
}

/**
 * Gives the file `from` a second name `to`, both entries of the folder `dirFd`. Atomic and never replacing: an existing
 * `to`, a link or a dangling one included, is EEXIST and is not followed.
 */
export function linkAt(dirFd: number, from: string, to: string): void {
  linkSync(inside(dirFd, from), inside(dirFd, to));
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

/** The components of `path` below `root`; refuses a path outside it, and `.`, `..`, empty or NUL components. */
export function componentsUnder(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("the path is outside its root");
  }
  const names = rel.split(sep);
  for (const name of names) inside(0, name);
  return names;
}

/**
 * Walks `path` below `root` one component at a time, each opened from its parent's descriptor with O_NOFOLLOW, and returns
 * the last folder (the caller closes it, and `rootFd` stays the caller's). With `create`, missing folders are made with it.
 */
export function openChain(rootFd: number, root: string, path: string, create?: number): number {
  let current = rootFd;
  try {
    for (const name of componentsUnder(root, path)) {
      const next = openDirAt(current, name, create === undefined ? {} : { create });
      if (current !== rootFd) closeSync(current);
      current = next;
    }
  } catch (error) {
    if (current !== rootFd) closeQuietly(current);
    throw error;
  }
  return current;
}

/** Opens the regular file `path` below `root`, a link refused at every component, the leaf included. */
export function openFileChain(
  rootFd: number,
  root: string,
  path: string,
  flags: number,
  mode = 0o600,
): number {
  if (root === "") throw new Error("the root is empty");
  const base = root.replace(/\/+$/, "") || "/";
  const name = basename(path);
  if (dirname(path) === base) return openAt(rootFd, name, flags, mode);
  const parent = openChain(rootFd, root, dirname(path));
  try {
    return openAt(parent, name, flags, mode);
  } finally {
    closeSync(parent);
  }
}

export const closeQuietly = (fd: number): void => {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
};
