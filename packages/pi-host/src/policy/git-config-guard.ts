import { opendir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { includeOf, otherObjectFormat, parseGitConfig, runsProgram } from "./git-config.ts";
import { discover, type Repository } from "./git-discovery.ts";
import { decodeStrict, pointer, present, readSmall } from "./git-fs.ts";
import { indexVerdict, MAX_INDEX_BYTES } from "./git-index.ts";
import { kernelResolve } from "./kernel-path.ts";

/**
 * Owner decision m3 (ADR 0024, M7 ruling MC4): a read-only git command runs unasked only when the repository's own
 * config runs nothing. The repository read is the one git would discover: from the folder git starts in, the nearest
 * folder with a `.git` (a folder, or a `gitdir:` file) or that is itself a bare repository; then its `commondir`,
 * `config`, `config.worktree` and every `include` / `includeIf` target, whatever the condition. Folders above that
 * repository are never read: an outer repository does not make an inner one ask. Discovery that cannot be resolved
 * asks. The owner's own `~/.gitconfig` and `/etc/gitconfig` are not read: they are his.
 */

export const MAX_GIT_CONFIG_BYTES = 64 * 1024;
/** Config files read for one command line, includes counted; past it the command asks. */
export const MAX_GIT_CONFIG_FILES = 32;
/** git's own include depth limit. */
const MAX_INCLUDE_DEPTH = 10;
const MAX_LEVELS = 64;

export const GIT_NO_REPO = "no git repository found";
export const GIT_UNREADABLE = "git config unreadable";
export const GIT_RUNS_PROGRAM = "git config runs a program";
export const GIT_INCLUDE = "git config include";
export const GIT_SUBMODULES = "git submodules";
export const GIT_TOO_MANY = "too many git config files";
export const GIT_TOO_DEEP = "git folder too deep";

type Why = string | null;

/** The check's state for one command line. */
export interface GitGuard {
  readonly home: string;
  /** Config files left to read. */
  files: number;
  /** Git directories already judged and the answer, so two git segments in one tree read nothing twice. */
  readonly seen: Map<string, Why>;
}
export const gitGuard = (home: string): GitGuard => ({ home, files: MAX_GIT_CONFIG_FILES, seen: new Map() });

/** git's `interpolate_path` for an include: `~/` is the home; a relative path starts at the including file's folder. */
async function includeTarget(value: string, from: string, home: string): Promise<string | null> {
  if (value === "" || value.includes("\0")) return null;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  if (value.startsWith("~") || value.startsWith("%(")) return null;
  try {
    return isAbsolute(value) ? value : await kernelResolve(from, value);
  } catch {
    return null;
  }
}

async function configRefusal(path: string, depth: number, guard: GitGuard): Promise<Why> {
  const read = await readSmall(path, MAX_GIT_CONFIG_BYTES);
  // git skips a missing include silently; the owner asked for a question instead (m3).
  if (read === "missing") return depth === 0 ? null : GIT_INCLUDE;
  if (read === "unreadable") return GIT_UNREADABLE;
  if (--guard.files < 0) return GIT_TOO_MANY;
  const text = decodeStrict(read.bytes);
  const entries = text === null ? null : parseGitConfig(text);
  if (entries === null) return GIT_UNREADABLE;
  for (const entry of entries) {
    if (runsProgram(entry)) return GIT_RUNS_PROGRAM;
    if (otherObjectFormat(entry)) return GIT_UNREADABLE;
    const include = includeOf(entry);
    if (include === undefined) continue;
    const target =
      include === null || depth >= MAX_INCLUDE_DEPTH
        ? null
        : await includeTarget(include, dirname(path), guard.home);
    if (target === null) return GIT_INCLUDE;
    const why = await configRefusal(target, depth + 1, guard);
    if (why !== null) return why;
  }
  return null;
}

/**
 * The index of `dir`, read for gitlinks (MC9): `git status` and `git diff` run `git status` inside the nested repository
 * of each one. A missing index is fine; a shared index (split index) is not read, so it asks.
 */
async function indexRefusal(dir: string): Promise<Why> {
  const read = await readSmall(join(dir, "index"), MAX_INDEX_BYTES);
  if (read === "unreadable") return GIT_UNREADABLE;
  if (read === "missing") return null;
  const verdict = indexVerdict(read.bytes);
  return verdict === "gitlink" ? GIT_SUBMODULES : verdict === "unreadable" ? GIT_UNREADABLE : null;
}

export const MAX_GIT_DIR_ENTRIES = 10_000;

/** A `sharedindex.<hash>` file means a split index, whose entries are not in `index`: it asks (MC9). */
async function sharedIndexRefusal(dir: string): Promise<Why> {
  try {
    const entries = await opendir(dir);
    let seen = 0;
    for await (const entry of entries) {
      if (entry.name.startsWith("sharedindex.")) return GIT_UNREADABLE;
      if (++seen > MAX_GIT_DIR_ENTRIES) return GIT_UNREADABLE;
    }
    return null;
  } catch {
    return GIT_UNREADABLE;
  }
}

/**
 * `git status` runs this hook whenever it rewrites the index, and it always does in a planted repository (MC8). A later
 * git with config-based hooks (`hook.<name>.command`) would need `hook.*` among the program keys: git 2.53 does not run them.
 */
const STATUS_HOOK = "post-index-change";

/**
 * A git directory: its `config` and `config.worktree`, and those of the common directory a worktree's names; the hook
 * `git status` runs; the index; and the `modules/` folder and `sharedindex.*` files that mean submodules or a split index.
 */
async function gitDirRefusal(gitDir: string, guard: GitGuard): Promise<Why> {
  const common = await pointer(join(gitDir, "commondir"), "", gitDir);
  if (common === null) return GIT_UNREADABLE;
  for (const dir of common === "missing" ? [gitDir] : [gitDir, common]) {
    // A submodule's own config lives under `modules/`: its git commands ask (git status recurses into it).
    if (await present(join(dir, "modules"))) return GIT_SUBMODULES;
    if (await present(join(dir, "hooks", STATUS_HOOK))) return GIT_RUNS_PROGRAM;
    for (const name of ["config", "config.worktree"]) {
      const why = await configRefusal(join(dir, name), 0, guard);
      if (why !== null) return why;
    }
  }
  for (const dir of common === "missing" ? [gitDir] : [gitDir, common]) {
    const split = await sharedIndexRefusal(dir);
    if (split !== null) return split;
  }
  return indexRefusal(gitDir);
}

async function repositoryRefusal(found: Repository, guard: GitGuard): Promise<Why> {
  if (found.workTree !== null && (await present(join(found.workTree, ".gitmodules")))) return GIT_SUBMODULES;
  return gitDirRefusal(found.gitDir, guard);
}

/** Why git started in `start` (a real path) could run a program the config of its repository names, or null. */
export async function repoConfigRefusal(start: string, guard: GitGuard, requireRepo = false): Promise<Why> {
  let folder = start;
  for (let level = 0; level <= MAX_LEVELS; level++) {
    const found = await discover(folder);
    if (found === "unresolvable") return GIT_UNREADABLE;
    if (found !== "none") {
      const key = `${found.workTree ?? ""}\0${found.gitDir}`;
      const cached = guard.seen.get(key);
      if (cached !== undefined) return cached;
      const why = await repositoryRefusal(found, guard);
      guard.seen.set(key, why);
      return why;
    }
    const parent = dirname(folder);
    if (parent === folder) return requireRepo ? GIT_NO_REPO : null;
    folder = parent;
  }
  return GIT_TOO_DEEP;
}
