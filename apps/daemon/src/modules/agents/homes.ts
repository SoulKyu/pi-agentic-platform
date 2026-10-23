import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { AgentId, AgentName, PapError } from "@pap/contracts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { stageInput } from "../../kernel/git/stage.ts";

export const AGENTS_DIR = "agents";
export const TRASH_DIR = ".trash";
/** Isolated tasks' scratch folders (owner m17): `<agents>/.runs/<agent id>/<task id>`, beside the homes, never inside one. */
export const RUNS_DIR = ".runs";

/** A private folder of ours at `path`, made 0700 when missing; refused when it is a link or not a directory. */
function privateDir(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) throw new PapError("internal");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  return path;
}

/** `<real $PAP_HOME>/agents`, made 0700 when missing; refused when it is a link or not a directory. */
export const agentsRoot = (papHome: string): string => privateDir(join(realpathSync(papHome), AGENTS_DIR));

/** Where an agent's home is (or would be): no folder is made and none is read. */
export const homePath = (papHome: string, agentId: string): string =>
  join(realpathSync(papHome), AGENTS_DIR, AgentId.parse(agentId));

/** Makes `<root>/<id>` (0700) and nothing else: an existing entry is `conflict`, never reused. */
export function makeHome(papHome: string, agentId: string): string {
  if (!AgentId.safeParse(agentId).success) throw new PapError("bad_request");
  const home = join(agentsRoot(papHome), agentId);
  try {
    mkdirSync(home, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PapError("conflict");
    throw error;
  }
  return home;
}

/** The home is in the trash but its scratch folders stayed behind: the delete is half done. */
export class HomeMovedRunsLeft extends Error {}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * Moves the home entry itself (a link inside is moved, never followed) to `.trash/<id>-<stamp>`, and its scratch
 * folders to `.trash/<id>-<stamp>.runs` when there are any; returns the home's new path.
 */
export function trashHome(papHome: string, agentId: string, stamp: number): string {
  if (!AgentId.safeParse(agentId).success) throw new PapError("bad_request");
  const root = agentsRoot(papHome);
  const trash = privateDir(join(root, TRASH_DIR));
  const target = join(trash, `${agentId}-${stamp}`);
  const runs = join(root, RUNS_DIR, agentId);
  // Checked before anything moves: a link in the scratch path fails the step with the home still in place.
  if (isLink(join(root, RUNS_DIR)) || isLink(runs)) throw new PapError("internal");
  renameSync(join(root, agentId), target);
  try {
    renameSync(runs, `${target}.runs`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new HomeMovedRunsLeft("runs_left", { cause: error });
  }
  return target;
}

/**
 * A retry after `HomeMovedRunsLeft`: the scratch folders the first try could not move go beside the trashed home, under a
 * name that cannot collide with what the first try left there. Nothing to move, nothing done.
 */
function moveRunsLeft(papHome: string, agentId: string, entry: string, stamp: number): void {
  const root = agentsRoot(papHome);
  const runs = join(root, RUNS_DIR, agentId);
  if (isLink(join(root, RUNS_DIR)) || isLink(runs)) throw new PapError("internal");
  if (!existsSync(runs)) return;
  const beside = join(root, TRASH_DIR, `${entry}.runs`);
  renameSync(runs, existsSync(beside) ? `${beside}-${stamp}` : beside);
}

/** The home to the trash (a link inside is moved, never followed); the entry of an earlier try when the folder is gone; "" when there is none. */
export function trashHomeOrFind(papHome: string, agentId: string, stamp: number): string {
  if (!AgentId.safeParse(agentId).success) return "";
  try {
    lstatSync(homePath(papHome, agentId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entry = trashedEntryOf(papHome, agentId);
    if (entry !== "") moveRunsLeft(papHome, agentId, entry, stamp);
    return entry;
  }
  return basename(trashHome(papHome, agentId, stamp));
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a task's scratch folder is (or would be): nothing is made and nothing is read but pap's home. */
export function scratchPathOf(papHome: string, agentId: string, taskId: string): string {
  if (!AgentId.safeParse(agentId).success || !TASK_ID.test(taskId)) throw new PapError("bad_request");
  return join(realpathSync(papHome), AGENTS_DIR, RUNS_DIR, agentId, taskId);
}

/**
 * The scratch folder of one isolated task (owner m17): `<root>/.runs/<id>/<task id>`, every level 0700 and not a link,
 * the last one made new (an existing one is `conflict`). The task's only writable folder; its thread reads it as
 * external content (M11R181).
 */
export function makeScratch(papHome: string, agentId: string, taskId: string): string {
  if (!AgentId.safeParse(agentId).success || !TASK_ID.test(taskId)) throw new PapError("bad_request");
  const agentRuns = privateDir(join(privateDir(join(agentsRoot(papHome), RUNS_DIR)), agentId));
  const scratch = join(agentRuns, taskId);
  try {
    mkdirSync(scratch, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PapError("conflict");
    throw error;
  }
  return scratch;
}

/**
 * The folder of a task that starts: made new, or, when the task starts again, the one it made before (`reused`). An
 * existing entry that is not a real directory is refused (`internal`), never followed.
 */
export function openScratch(
  papHome: string,
  agentId: string,
  taskId: string,
): { readonly path: string; readonly reused: boolean } {
  try {
    return { path: makeScratch(papHome, agentId, taskId), reused: false };
  } catch (error) {
    if (!(error instanceof PapError && error.code === "conflict")) throw error;
  }
  const path = scratchPathOf(papHome, agentId, taskId);
  if (!lstatSync(path).isDirectory()) throw new PapError("internal");
  return { path, reused: true };
}

/**
 * Removes one task's scratch folder (its task session deleted): its parents must not be links; a link inside is removed,
 * never followed. Only for a folder no live sandbox writes to (see `removeTree`): `dropFresh` and the housekeeping dropper.
 */
export function removeScratch(papHome: string, agentId: string, taskId: string, issue?: WalkIssue): void {
  if (!AgentId.safeParse(agentId).success || !TASK_ID.test(taskId)) throw new PapError("bad_request");
  const agentRuns = privateDir(join(privateDir(join(agentsRoot(papHome), RUNS_DIR)), agentId));
  removeTree(join(agentRuns, taskId), issue ? { issue } : {});
}

// Linux `O_PATH`: Node does not export it. A folder the task locked with `chmod 000` cannot be opened for reading, but its
// inode can be held by path, and the permissions are then set through /proc/self/fd (never through the name again).
const O_PATH = 0o10000000;
const DIRECTORY_NOFOLLOW = constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** A test seam: told at two points of the walk of a folder, so a test can swap an entry exactly there. */
export type WalkStage = "opened" | "listed";
export type WalkHook = (stage: WalkStage, folder: string) => void;

/** How deep the unlocking walk goes; a task's shell can build a tree far deeper than any descriptor budget. */
export const MAX_WALK_DEPTH = 256;

/** What a removal tells its caller instead of staying silent: `too_deep`, or the code of an open that failed unexpectedly. */
export type WalkIssue = (info: { readonly code: string }) => void;

interface Walk {
  readonly hook: WalkHook | undefined;
  readonly maxDepth: number;
  readonly issue: WalkIssue | undefined;
  tooDeep: boolean;
}

// An entry that is gone, or swapped for a link or a file, is not a failure to tell: the open refuses it by design.
const EXPECTED_OPEN = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"]);

function openFolder(open: string, walk: Walk): { fd: number; held: boolean } | null {
  try {
    return { fd: openSync(open, constants.O_RDONLY | DIRECTORY_NOFOLLOW), held: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code !== "EACCES") {
      if (!EXPECTED_OPEN.has(code)) walk.issue?.({ code });
      return null;
    }
  }
  try {
    return { fd: openSync(open, O_PATH | DIRECTORY_NOFOLLOW), held: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (!EXPECTED_OPEN.has(code)) walk.issue?.({ code });
    return null;
  }
}

/**
 * Gives a real directory its owner's `rwx` back, then does the same to the directories in it. Nothing is resolved by
 * name after the first open: the folder is held by a descriptor (changed through it, listed through
 * `/proc/self/fd/<fd>`), and each child is opened relative to its parent's descriptor with `O_NOFOLLOW | O_DIRECTORY`,
 * so a subdirectory swapped for a link while the walk runs is refused by that open, never followed. `folder` is the
 * name used for messages and for the test seam only. A descriptor is closed on every path. The walk stops at
 * `maxDepth` levels (the ancestors' descriptors are all open at once) and says so once.
 */
function unlockTree(open: string, folder: string, walk: Walk, depth: number): void {
  if (depth > walk.maxDepth) {
    if (!walk.tooDeep) walk.issue?.({ code: "too_deep" });
    walk.tooDeep = true;
    return;
  }
  const opened = openFolder(open, walk);
  if (opened === null) return;
  const { fd, held } = opened;
  try {
    const via = `/proc/self/fd/${fd}`;
    const mode = (fstatSync(fd).mode & 0o7777) | 0o700;
    if (held) chmodSync(via, mode);
    else fchmodSync(fd, mode);
    walk.hook?.("opened", folder);
    const names = readdirSync(via, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    walk.hook?.("listed", folder);
    for (const name of names) unlockTree(`${via}/${name}`, join(folder, name), walk, depth + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * Deletes a folder the task's own shell may have locked (`chmod 000`, `500`): every real directory in it gets its owner's
 * `rwx` back first, never following a link (see `unlockTree`); then it is removed (a link inside goes, not its target).
 *
 * The final `rmSync` deletes by name, which is safe only because no task process can be alive in the folder. Never call
 * this on a folder a live sandbox can write to. Its callers keep that true: `dropFresh` (runner-agent.ts) removes a
 * folder the task never started in, and the 30-day housekeeping dropper skips any folder a live session works in
 * (`taskFolders()`, housekeeping.agent.test.ts); sandboxed commands run under `bwrap --die-with-parent` from a worker
 * that has long been released by then. `options` are test seams and the caller's way to hear of a walk that stopped.
 */
export function removeTree(
  path: string,
  options: { hook?: WalkHook; maxDepth?: number; issue?: WalkIssue } = {},
): void {
  const walk: Walk = {
    hook: options.hook,
    maxDepth: options.maxDepth ?? MAX_WALK_DEPTH,
    issue: options.issue,
    tooDeep: false,
  };
  unlockTree(path, path, walk, 0);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Removes the scratch folders `keep` does not name (their task row and their session are gone): only real directories of
 * the exact `.runs/<agent id>/<task uuid>` shape, at most `limit` a pass. A link at either level is unlinked, never
 * followed. Nothing is made when there is no `.runs`. Returns how many entries went.
 */
export function sweepScratch(
  papHome: string,
  keep: (agentId: string, taskId: string, path: string) => boolean,
  limit: number,
  onError?: (info: { code: string; name: string }) => void,
): number {
  // Nothing is made, and a linked `agents` folder is refused here as everywhere else (`agentsRoot`).
  if (!existsSync(join(realpathSync(papHome), AGENTS_DIR))) return 0;
  const runs = join(agentsRoot(papHome), RUNS_DIR);
  const kindOf = (path: string): "dir" | "link" | null => {
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : null;
    } catch {
      return null;
    }
  };
  if (kindOf(runs) !== "dir") return 0;
  let removed = 0;
  for (const agentId of readdirSync(runs)) {
    if (removed >= limit) break;
    const agentRuns = join(runs, agentId);
    const kind = AgentId.safeParse(agentId).success ? kindOf(agentRuns) : null;
    if (kind === "link") {
      unlinkSync(agentRuns);
      removed += 1;
    }
    if (kind !== "dir") continue;
    for (const taskId of readdirSync(agentRuns)) {
      const path = join(agentRuns, taskId);
      try {
        const entry = TASK_ID.test(taskId) ? kindOf(path) : null;
        if (removed >= limit || entry === null || (entry === "dir" && keep(agentId, taskId, path))) continue;
        if (entry === "link") unlinkSync(path);
        else removeTree(path, { issue: ({ code }) => onError?.({ code, name: taskId }) });
        removed += 1;
      } catch (error) {
        // One folder that will not go never stops the pass: its code and its name (a task id) are told, nothing else.
        onError?.({ code: (error as NodeJS.ErrnoException).code ?? "unknown", name: taskId });
      }
    }
  }
  return removed;
}

/** The newest trash entry of an agent's home (`<id>-<stamp>`), or "" when there is none: a retried delete names it. */
export function trashedEntryOf(papHome: string, agentId: string): string {
  const prefix = `${AgentId.parse(agentId)}-`;
  let names: string[];
  try {
    names = readdirSync(join(realpathSync(papHome), AGENTS_DIR, TRASH_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const stamps = names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => ({ name, stamp: Number(name.slice(prefix.length)) }));
  stamps.sort((a, b) => b.stamp - a.stamp);
  return stamps[0]?.name ?? "";
}

const SEEDED = [".gitignore"] as const;

/**
 * Fills a home made by `makeHome` (M11R46): `prompts/` (0700), `.gitignore`, then `git init -b main`
 * and one commit through the kernel runner, which switches hooks and the owner's templates off; the identity is the
 * agent's own, in the new repository's config. pap runs git in a home only here (ADR 0050).
 */
export async function initHome(
  git: Pick<GitRunner, "run">,
  home: string,
  agent: { readonly id: string; readonly name: string },
): Promise<void> {
  const id = AgentId.parse(agent.id);
  const name = AgentName.parse(agent.name);
  mkdirSync(join(home, "prompts"), { mode: 0o700 });
  writeFileSync(join(home, ".gitignore"), ".pi/\n.claude/\n", { flag: "wx", mode: 0o600 });
  await git.run(home, ["init", "--initial-branch=main", "--template="]);
  const gitDir = join(home, ".git");
  appendFileSync(join(gitDir, "config"), `[user]\n\tname = ${name}\n\temail = ${id}@pap.local\n`);
  const paths = stageInput(SEEDED);
  if (paths === null) throw new PapError("internal");
  await git.run(home, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { gitDir, input: paths });
  await git.run(
    home,
    ["commit", "--file=-", "--no-gpg-sign", "--quiet", "--", ...SEEDED.map((path) => `./${path}`)],
    {
      gitDir,
      input: Buffer.from(`chore: init ${name} home\n`),
    },
  );
}

/** The agent's home folder is still there (a link counts, it is never followed): false once a delete moved it to the trash. */
export function homeExists(papHome: string, agentId: string): boolean {
  try {
    lstatSync(homePath(papHome, agentId));
    return true;
  } catch {
    return false;
  }
}
