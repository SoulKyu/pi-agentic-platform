import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_LEVELS = 64;

/** True when `dir` holds a `.git` folder or file; false when it holds none; null when that cannot be told. */
function holdsGit(dir: string): boolean | null {
  try {
    const entry = statSync(join(dir, ".git"), { throwIfNoEntry: false });
    return entry !== undefined && (entry.isDirectory() || entry.isFile());
  } catch (error) {
    // Not a folder (ENOTDIR) is plain absence; anything else (permissions, a loop) leaves the answer unknown.
    return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? false : null;
  }
}

/**
 * The project an "always" rule belongs to (owner R2-5, M2R68): the git root of `cwd`, that is the nearest folder, `cwd`
 * included, that holds `.git` (a folder, or the file of a worktree or a submodule), at most 64 levels up; else `cwd`.
 * Real paths, so a link and its target are one project.
 *
 * Fails closed: the scope only ever narrows. A `cwd` that is missing, unreadable, a symlink loop or not a folder is its
 * own project (as an absolute path), never the repository above it; so is a folder where `.git` cannot be looked up, and
 * one with no repository within 64 levels. A rule stored for such a path matches that exact path and nothing wider.
 *
 * Synchronous on purpose (`PolicyPort.scopeOf` is): it runs once per session creation or rule listing, not per tool
 * call, and costs at most 64 `stat` calls.
 */
export function projectScopeOf(cwd: string): string {
  let real: string;
  try {
    real = realpathSync(cwd);
    if (!statSync(real).isDirectory()) return real;
  } catch {
    return resolve(cwd);
  }
  let dir = real;
  for (let level = 0; level < MAX_LEVELS; level++) {
    const found = holdsGit(dir);
    if (found === null) return real;
    if (found) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return real;
}
