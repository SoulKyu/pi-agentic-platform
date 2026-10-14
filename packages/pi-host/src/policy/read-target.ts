import { join, relative, resolve, sep } from "node:path";
import { kernelResolve, tooLong } from "./kernel-path.ts";
import { asPiResolves, type EditReview, KERNEL_CONDITION, realTarget, within } from "./target-path.ts";

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
  /** The session's own id: its attachments are readable, other sessions' are not. Absent: none is (fail closed). */
  readonly sessionId?: string | undefined;
}

/** What the daemon names a session's folder under `attachments/`; anything else is no session of ours. */
const SESSION_FOLDER = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * M7 rebase item 2 (M8 final review I3): `attachments/pending/` is always asked, so is `attachments/<sid>/` for any
 * `sid` but the session's own, and so is a search rooted at `attachments/` (it would walk the others). Listing
 * `attachments/` itself shows session ids only.
 */
function inOthersAttachments(
  candidate: string,
  roots: readonly string[],
  own: string | undefined,
  searches: boolean,
): boolean {
  return roots.some((root) => {
    if (!within(root, candidate)) return false;
    const [first] = relative(root, candidate).split(sep);
    if (first === "" || first === undefined) return searches;
    return first === "pending" || first !== own;
  });
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
 * backups and exports, Pi's credentials, other sessions' transcripts and attachments (a call that returns a review asks; in
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
  if (typeof path !== "string" || path === "" || path.includes("\0") || tooLong(path)) return UNREADABLE_PATH;

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
  const attachmentRoots = await withRealPaths(papHomes.map((home) => join(home, "attachments")));
  const ownSession =
    dirs.sessionId !== undefined && SESSION_FOLDER.test(dirs.sessionId) ? dirs.sessionId : undefined;

  let target: string | undefined;
  let kernelTarget: string | undefined;
  let kernelReason: string | undefined;
  let piReason: string | undefined;
  let protectedPath = false;
  let searches = false;
  const reasonOf = (verdict: { protectedPath: boolean; searches: boolean }) =>
    verdict.protectedPath ? "protected path" : verdict.searches ? "searches pap's data directory" : undefined;
  const judge = (candidates: readonly string[]) => ({
    protectedPath:
      sensitive.some((entry) => candidates.some((candidate) => within(entry, candidate))) ||
      candidates.some((candidate) =>
        inOthersAttachments(candidate, attachmentRoots, ownSession, SEARCH_TOOLS.has(toolName)),
      ),
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
    piReason ??= reasonOf(pi);
    if (kernelTarget === undefined && reasonOf(other) !== undefined) {
      kernelTarget = kernel;
      kernelReason = reasonOf(other);
    }
    protectedPath ||= pi.protectedPath || other.protectedPath;
    searches ||= pi.searches || other.searches;
  }
  // The card names the file Pi acts on (R88b); the kernel's reading is a second line when it differs.
  const also =
    kernelTarget !== undefined && kernelTarget !== target
      ? {
          kernelTarget,
          targetLabel: piReason ?? "the file Pi reads",
          kernelLabel: `${kernelReason}, ${KERNEL_CONDITION}`,
        }
      : {};
  if (protectedPath) return { why: "protected path", target, ...also };
  if (searches) return { why: "searches pap's data directory", target, ...also };
  return undefined;
}
