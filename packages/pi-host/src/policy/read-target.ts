import { join, resolve } from "node:path";
import { kernelResolve } from "./kernel-path.ts";
import { asPiResolves, type EditReview, realTarget, within } from "./target-path.ts";

/** What lives in pap's home that no tool call of a session has a reason to read (M5R29, R97). */
export const PAP_SENSITIVE = [
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "pap.lock",
  "secrets",
  "backups",
  "exports",
  "fork-tmp",
] as const;

const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
/** These walk a whole tree: rooted above pap's files they would read them. `ls` only lists names. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "find"]);
const UNREADABLE_PATH: EditReview = { why: "protected path" };

export interface ReadDirs {
  readonly cwd: string;
  readonly papHome: string;
  readonly agentDir: string;
}

/** A directory as spelled and as it resolves, so a symlink on either side cannot hide it. */
async function variantsOf(spelled: string): Promise<string[]> {
  const lexical = resolve(spelled);
  return [...new Set([lexical, await realTarget(lexical)])];
}

async function withRealPaths(paths: readonly string[]): Promise<string[]> {
  const all = await Promise.all(paths.map(variantsOf));
  return [...new Set(all.flat())];
}

/**
 * Whether a built-in `read`, `grep`, `find` or `ls` touches what pap keeps from the model: its database, secrets,
 * backups and exports, Pi's credentials and other sessions' transcripts (a call that returns a review asks; in
 * read-only it blocks). The path is judged as Pi resolves it and as it was spelled, symlinks followed. A `grep` or
 * `find` rooted at pap's home, at Pi's agent directory or above either would read them: it asks too. A path that is not
 * a plain string fails closed. Any other tool is not judged here.
 */
export async function checkReadTarget(
  toolName: string,
  input: unknown,
  dirs: ReadDirs,
): Promise<EditReview | undefined> {
  if (!READ_TOOLS.has(toolName)) return undefined;
  const given =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as { path?: unknown }).path
      : null;
  // grep, find and ls default to the session folder; read has no default.
  const path = given === undefined && toolName !== "read" ? dirs.cwd : given;
  if (typeof path !== "string" || path === "" || path.includes("\0")) return UNREADABLE_PATH;

  const papHomes = await variantsOf(dirs.papHome);
  const agentDirs = await variantsOf(dirs.agentDir);
  const sessionDirs = await withRealPaths(agentDirs.map((dir) => join(dir, "sessions")));
  const cwdReal = await realTarget(resolve(dirs.cwd));
  const ownSessionFolder = sessionDirs.some((dir) => within(dir, cwdReal));
  const sensitive = await withRealPaths([
    ...papHomes.flatMap((home) => PAP_SENSITIVE.map((name) => join(home, name))),
    ...agentDirs.map((dir) => join(dir, "auth.json")),
    ...(ownSessionFolder ? [] : sessionDirs),
  ]);
  const roots = [...papHomes, ...agentDirs];

  let target: string | undefined;
  let kernelTarget: string | undefined;
  let protectedPath = false;
  let searches = false;
  const judge = (candidates: readonly string[]) => ({
    protectedPath: sensitive.some((entry) => candidates.some((candidate) => within(entry, candidate))),
    searches:
      SEARCH_TOOLS.has(toolName) &&
      roots.some((root) => candidates.some((candidate) => within(candidate, root))),
  });
  for (const spelling of new Set([asPiResolves(path), path])) {
    const lexical = resolve(dirs.cwd, spelling);
    const real = await realTarget(lexical);
    target ??= real;
    // Pi collapses `..` before it follows a symlink, the kernel after: both readings are judged (probed).
    const kernel = await kernelResolve(dirs.cwd, spelling);
    const pi = judge([lexical, real]);
    const other = judge([kernel]);
    if (other.protectedPath || other.searches) kernelTarget ??= kernel;
    protectedPath ||= pi.protectedPath || other.protectedPath;
    searches ||= pi.searches || other.searches;
  }
  // The card names the file Pi acts on, unless the kernel's reading is a problem too: then the one it reaches.
  target = kernelTarget ?? target;
  if (protectedPath) return { why: "protected path", target };
  if (searches) return { why: "searches pap's data directory", target };
  return undefined;
}
