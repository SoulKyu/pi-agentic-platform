import { randomBytes } from "node:crypto";
import { access, constants, copyFile, lstat, mkdir, rm, utimes } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LANE_LIMITS } from "@pap/contracts";
import { parseRawDiff } from "./diff-lists.ts";
import { dropNewGitlinks } from "./nested.ts";
import { GitError, type GitRunner } from "./runner.ts";
import { MAX_STAGE_BYTES, MAX_STAGE_PATHS, stageInputAllowed } from "./stage.ts";

/** A file the checkpoint does not hold. A restore leaves it where it is. */
export interface LeftEntry {
  /**
   * The path relative to the lane root, as the raw bytes git printed (a name need not be UTF-8). `conflict` is a
   * restore's answer only: the target holds a file where the lane has a folder with a left-in-place file in it, or with
   * entries the capture did not hold (`ignored`, listed next to the `conflict`).
   */
  readonly path: Buffer;
  readonly reason: "large" | "unreadable" | "conflict" | "ignored";
}

export interface Snapshot {
  /** The tree of the lane as it is now: tracked changes, deletions and untracked files, ignored files left out. */
  readonly tree: string;
  /** `left.length`. */
  readonly skipped: number;
  readonly left: readonly LeftEntry[];
}

const STEP_TIMEOUT_MS = 60_000;
const GITLINK = "160000";
const STAGE = ["add", "--pathspec-from-file=-", "--pathspec-file-nul"] as const;

/** The lane's HEAD commit, or null on an unborn branch. */
export async function headOf(git: GitRunner, root: string, gitDir: string): Promise<string | null> {
  const head = await git.run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    gitDir,
    okCodes: [0, 1],
  });
  return head.code === 0 ? head.stdout.toString("utf8").trim() : null;
}

/** Batches of at most `MAX_STAGE_PATHS` paths and `MAX_STAGE_BYTES` bytes: `stageInputAllowed` refuses a longer list. Paths are latin1 strings. */
export function batches(paths: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = path.length + 1;
    if (current.length >= MAX_STAGE_PATHS || bytes + size > MAX_STAGE_BYTES) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const within = (path: string, scope: readonly string[] | undefined): boolean =>
  scope === undefined ||
  scope.some((entry) => path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`));

/**
 * The tree of the lane's files right now, built in a temporary index so the real index, HEAD and the worktree are
 * never written (M9R54). MC1 I3: the staged list is explicit and goes on stdin; MC2: gitlinks (tracked, or an untracked
 * nested repository) are never staged, so no nested repository's filter runs. Tracked entries stay as the index has them.
 *
 * Paths are raw bytes: git's output is read as latin1 (one character per byte) and written back the same way, so a name
 * that is not UTF-8 is staged, not lost. One odd file never sinks the capture (fix round 1): an untracked file over
 * `maxFileBytes`, an unreadable one, or one a single `add` refuses is left out and returned in `left` with its reason.
 */
export async function snapshotTree(
  git: GitRunner,
  root: string,
  gitDir: string,
  indexDir: string,
  paths?: readonly string[],
  maxFileBytes: number = LANE_LIMITS.checkpointFileBytes,
): Promise<Snapshot> {
  await mkdir(indexDir, { recursive: true });
  const temp = join(indexDir, `idx-${randomBytes(16).toString("hex")}`);
  const env = { GIT_INDEX_FILE: temp };
  const scope = paths?.map((path) => Buffer.from(path, "utf8").toString("latin1"));
  const run = (args: readonly string[], more: { input?: Buffer } = {}) =>
    git.run(root, args, { gitDir, env, timeoutMs: STEP_TIMEOUT_MS, ...more });
  const abs = (path: string): Buffer => Buffer.concat([Buffer.from(`${root}/`), Buffer.from(path, "latin1")]);

  const seed = async (): Promise<void> => {
    const head = await headOf(git, root, gitDir);
    await run(head === null ? ["read-tree", "--empty"] : ["read-tree", "HEAD"]);
  };
  /** M9-RT-17: the copy keeps the real index's stat cache, so `diff` hashes only what changed. False when there is none. */
  const copyRealIndex = async (): Promise<boolean> => {
    const named = (await git.run(root, ["rev-parse", "--git-path", "index"], { gitDir })).stdout
      .toString("utf8")
      .trim();
    const real = isAbsolute(named) ? named : join(root, named);
    try {
      // A FIFO or a device at `index` would hang the copy under the lane lock; a symlink is not followed either.
      const info = await lstat(real);
      if (!info.isFile()) return false;
      const { mtime } = info;
      await copyFile(real, temp);
      await utimes(temp, mtime, mtime);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return false;
      throw error;
    }
  };

  const symlinked = new Map<string, boolean>();
  /** True when a folder on the way to `path` is now a symlink: git refuses a pathspec beyond it. */
  const beyondSymlink = async (path: string): Promise<boolean> => {
    const parts = path.split("/").slice(0, -1);
    let prefix = "";
    for (const part of parts) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      let linked = symlinked.get(prefix);
      if (linked === undefined) {
        linked = await lstat(abs(prefix)).then(
          (info) => info.isSymbolicLink(),
          () => false,
        );
        symlinked.set(prefix, linked);
      }
      if (linked) return true;
    }
    return false;
  };
  const readable = (path: string): Promise<boolean> =>
    access(abs(path), constants.R_OK).then(
      () => true,
      () => false,
    );

  const stage = async (perFile: boolean): Promise<LeftEntry[]> => {
    const left: LeftEntry[] = [];
    const leave = (path: string, reason: LeftEntry["reason"]): void => {
      left.push({ path: Buffer.from(path, "latin1"), reason });
    };
    // Tracked changes, deletions included; `--ignore-submodules=dirty` keeps a nested repository unread.
    const changed = parseRawDiff(
      (await run(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--ignore-submodules=dirty"])).stdout,
      "latin1",
    ).filter((entry) => entry.oldMode !== GITLINK && entry.newMode !== GITLINK && within(entry.path, scope));
    const staged: string[] = [];
    for (const entry of changed) {
      // Beyond a symlink, or now a folder: the untracked entries that replace it stage the removal; a pathspec would
      // fail ("beyond a symbolic link") or take in the folder's files whatever their size.
      if (await beyondSymlink(entry.path)) continue;
      const info = await lstat(abs(entry.path)).catch(() => null);
      if (info?.isDirectory()) continue;
      if (info?.isFile() && !(await readable(entry.path))) leave(entry.path, "unreadable");
      else staged.push(entry.path);
    }
    // Untracked and not ignored. A nested repository is listed as `dir/`: a gitlink, never staged.
    const listed = (await run(["ls-files", "-z", "--others", "--exclude-standard"])).stdout
      .toString("latin1")
      .split("\0")
      .filter((path) => path !== "" && !path.endsWith("/") && within(path, scope));
    for (const path of listed) {
      const info = await lstat(abs(path)).catch(() => null);
      if (info === null) leave(path, "unreadable");
      else if (info.isFile() && info.size > maxFileBytes) leave(path, "large");
      else if (info.isFile() && !(await readable(path))) leave(path, "unreadable");
      else staged.push(path);
    }
    const add = (group: readonly string[]): Promise<unknown> => {
      const input = Buffer.from(group.map((path) => `${path}\0`).join(""), "latin1");
      if (!stageInputAllowed(input)) throw new GitError("failed");
      return run(STAGE, { input });
    };
    for (const group of batches(staged)) {
      try {
        await add(group);
      } catch (error) {
        if (!perFile || !(error instanceof GitError) || error.kind !== "failed") throw error;
        // The index was rebuilt from HEAD, so a refusal is the file's own: leave that one out and go on.
        for (const path of group) {
          try {
            await add([path]);
          } catch (single) {
            if (!(single instanceof GitError) || single.kind !== "failed") throw single;
            leave(path, "unreadable");
          }
        }
      }
    }
    return left;
  };

  try {
    const copied = await copyRealIndex();
    if (!copied) await seed();
    let left: LeftEntry[];
    try {
      left = await stage(false);
    } catch (error) {
      // A split index keeps its shared part beside the real file, and a file may be refused: rebuild from HEAD and
      // run once more, file by file.
      if (!(error instanceof GitError) || error.kind !== "failed") throw error;
      await rm(temp, { force: true });
      await seed();
      left = await stage(true);
    }
    // MC2: a nested repository below an untracked folder must not become a gitlink in the checkpoint either.
    await dropNewGitlinks(git, root, gitDir, env, "latin1");
    const tree = (await run(["write-tree"])).stdout.toString("utf8").trim();
    return { tree, skipped: left.length, left };
  } finally {
    await rm(temp, { force: true });
  }
}
