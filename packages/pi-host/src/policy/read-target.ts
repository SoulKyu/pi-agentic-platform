import { lstat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { PolicyProfile } from "@pap/contracts/pi-host";
import { kernelResolve, tooLong } from "./kernel-path.ts";
import {
  AGENTS_DIR,
  asPiResolves,
  type EditReview,
  KERNEL_CONDITION,
  ownFolder,
  realTarget,
  RUNS_DIR,
  within,
} from "./target-path.ts";

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
  /** The session's profile and the folders its rules name (M11R29): an interactive session, or none given, owns none. */
  readonly profile?: PolicyProfile | undefined;
  readonly agentHome?: string | null | undefined;
  readonly agentScratch?: string | null | undefined;
}

/** What the daemon names a session's folder under `attachments/`; anything else is no session of ours. */
export const SESSION_FOLDER = /^[A-Za-z0-9_-]{1,128}$/;

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

/** The path a built-in read names: `grep`, `find` and `ls` default to the session folder, `read` has no default. */
function namedPath(toolName: string, input: unknown, cwd: string): unknown {
  const given =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as { path?: unknown }).path
      : null;
  return given === undefined && toolName !== "read" ? cwd : given;
}
const unreadable = (path: unknown): boolean =>
  typeof path !== "string" || path === "" || path.includes("\0") || tooLong(path);

/** M11R29: the home, and the one runs folder, the rules let the session read unasked (a thread: its agent's; a task: its own). */
async function ownAgentFolders(dirs: ReadDirs): Promise<string[]> {
  if (dirs.profile === undefined || dirs.profile === "interactive") return [];
  const named = (folder: string | null | undefined) =>
    folder ? ownFolder(dirs.cwd, dirs.papHome, folder) : Promise.resolve([]);
  const home = await named(dirs.agentHome);
  const runs =
    dirs.profile === "isolated-task"
      ? await named(dirs.agentScratch)
      : home.map((each) => join(dirname(each), RUNS_DIR, basename(each)));
  return withRealPaths([...home, ...runs]);
}

/** Under `agents/` everything but the session's own folders asks; a search rooted at `agents/` itself would walk them all. */
function inOthersAgents(
  candidate: string,
  agents: readonly string[],
  own: readonly string[],
  searches: boolean,
): boolean {
  return agents.some(
    (dir) =>
      within(dir, candidate) && (candidate === dir ? searches : !own.some((mine) => within(mine, candidate))),
  );
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
  const path = namedPath(toolName, input, dirs.cwd);
  if (typeof path !== "string" || unreadable(path)) return UNREADABLE_PATH;

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
  const agentsDirs = await withRealPaths(papHomes.map((home) => join(home, AGENTS_DIR)));
  const ownAgents = await ownAgentFolders(dirs);
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
      ) ||
      candidates.some((candidate) =>
        inOthersAgents(candidate, agentsDirs, ownAgents, SEARCH_TOOLS.has(toolName)),
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

export const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;
export const REWRITTEN = /^(?:~|@|file:)/;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * An isolated task reads its agent home and its own scratch folder and nothing else (M11R33, owner m17): every spelling
 * Pi or the kernel could open must land inside one of `roots`' real paths, and the path must exist (Pi retries a
 * missing path with rewritten variants). True: allowed.
 */
export async function readsInside(
  paths: readonly unknown[],
  cwd: string,
  roots: readonly string[],
  allowMissing = false,
): Promise<boolean> {
  const reals = await Promise.all(roots.map((root) => realTarget(resolve(root))));
  const inside = (target: string) => reals.some((root) => within(root, target));
  for (const path of paths.length === 0 ? [cwd] : paths) {
    if (typeof path !== "string" || unreadable(path)) return false;
    if (REWRITTEN.test(path) || UNICODE_SPACE.test(path)) return false;
    for (const spelling of new Set([asPiResolves(path), path])) {
      const lexical = resolve(cwd, spelling);
      // A thread's missing path is judged by its nearest existing parent (`realTarget`, W5-R65): Pi then says "not found".
      if (!allowMissing && !(await exists(lexical))) return false;
      if (!inside(await realTarget(lexical))) return false;
      if (!inside(await kernelResolve(cwd, spelling))) return false;
    }
  }
  return true;
}

type AgentFolderKind = "runs" | "homes";

async function readsAgentFolder(
  kind: AgentFolderKind,
  toolName: string,
  input: unknown,
  dirs: Pick<ReadDirs, "cwd" | "papHome" | "profile" | "agentScratch" | "agentHome">,
): Promise<boolean> {
  if (!READ_TOOLS.has(toolName)) return false;
  const path = namedPath(toolName, input, dirs.cwd);
  if (typeof path !== "string" || unreadable(path)) return true;
  const agents = await withRealPaths((await variantsOf(dirs.papHome)).map((home) => join(home, AGENTS_DIR)));
  const runs = agents.map((dir) => join(dir, RUNS_DIR));
  const scratch = dirs.profile === "isolated-task" && dirs.agentScratch ? dirs.agentScratch : null;
  const home = dirs.profile !== undefined && dirs.profile !== "interactive" ? dirs.agentHome : null;
  const own = await withRealPaths([
    ...(scratch === null ? [] : await ownFolder(dirs.cwd, dirs.papHome, scratch)),
    ...(home ? await ownFolder(dirs.cwd, dirs.papHome, home) : []),
  ]);
  const search = SEARCH_TOOLS.has(toolName);
  const under = (dir: string, candidate: string) =>
    within(dir, candidate) || (search && within(candidate, dir));
  const touches = (candidate: string) =>
    kind === "runs"
      ? runs.some((dir) => under(dir, candidate))
      : agents.some(
          (dir) => (within(dir, candidate) && candidate !== dir) || (search && within(candidate, dir)),
        ) && !runs.some((dir) => within(dir, candidate));
  const isOwn = (candidate: string) => own.some((dir) => within(dir, candidate));
  for (const spelling of new Set([asPiResolves(path), path])) {
    const lexical = resolve(dirs.cwd, spelling);
    const readings = [lexical, await realTarget(lexical), await kernelResolve(dirs.cwd, spelling)];
    if (readings.some(touches) && !readings.every(isOwn)) return true;
  }
  return false;
}

/**
 * M11R181, W5-R9: whether a built-in `read`, `grep`, `find` or `ls` touches `<papHome>/agents/.runs`, in any spelling of
 * pap's home and both readings of the path (a missing path counts when its nearest existing ancestor does; a search
 * starting above it too). What those folders hold was written by runs nobody watched: the result is external content.
 * One exception: an isolated task reading its own scratch folder (every reading of the path inside it): that is its own
 * work, and anything external it fetched already tainted it. A path it cannot read counts as touching.
 */
export const readsRunsFolder = (
  toolName: string,
  input: unknown,
  dirs: Pick<ReadDirs, "cwd" | "papHome" | "profile" | "agentScratch" | "agentHome">,
): Promise<boolean> => readsAgentFolder("runs", toolName, input, dirs);

/**
 * W5-R45, W5-R46: the same for `<papHome>/agents/<id>/`, the homes (a delegate's `outbox/<task>/` may hold what a tainted
 * run wrote). For every reader, an owner's session and an M10 task session included: with no folders of its own, every
 * agent home is another's. An agent reading its own home is not touching.
 */
export const readsAgentHome = (
  toolName: string,
  input: unknown,
  dirs: Pick<ReadDirs, "cwd" | "papHome" | "profile" | "agentScratch" | "agentHome">,
): Promise<boolean> => readsAgentFolder("homes", toolName, input, dirs);
