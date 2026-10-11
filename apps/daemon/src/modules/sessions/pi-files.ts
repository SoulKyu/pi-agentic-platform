import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The real path of a file, or, while it does not exist yet, of its nearest existing folder with the rest of the path after it. */
function realOf(path: string): string {
  const rest: string[] = [];
  for (let current = path; ;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** A file that exists must be a regular file (opening a pipe would block), and a link must lead to one. */
function isRegularOrMissing(path: string): boolean {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return true;
  }
  if (!entry.isSymbolicLink()) return entry.isFile();
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a path a worker reported can be a session file of Pi: a `.jsonl` below `<agentDir>/sessions`. The path
 * comes from the worker (untrusted, R66) and is later read by the daemon and handed back to a worker, so it is
 * checked before the daemon remembers it. Both sides are compared as real paths: a link under `sessions/` that points
 * outside is refused.
 */
export function isPiSessionFile(agentDir: string, path: string): boolean {
  if (!isAbsolute(path) || path.includes("\0") || !path.endsWith(".jsonl")) return false;
  const inside = relative(realOf(join(resolve(agentDir), "sessions")), realOf(resolve(path)));
  return (
    isRegularOrMissing(resolve(path)) &&
    inside !== "" &&
    inside !== ".." &&
    !inside.startsWith(`..${sep}`) &&
    !isAbsolute(inside)
  );
}

/** The size of a file, or 0 for one that does not exist (yet): Pi writes a session's file with its first message. */
export function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
