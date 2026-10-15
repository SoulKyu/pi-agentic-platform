import { type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import { parseRawDiff } from "../../kernel/git/diff-lists.ts";
import { dropNewGitlinks } from "../../kernel/git/nested.ts";
import { parsePorcelainV2, type PorcelainEntry } from "../../kernel/git/porcelain.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { stageInput } from "../../kernel/git/stage.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LaneLock } from "./lane-lock.ts";
import type { LaneNotices } from "./notices.ts";
import type { LaneRow, LanesStore } from "./store.ts";

type CommitResult = ResultOf<"lanes.commit">;
type Refusal = Extract<CommitResult, { ok: false }>["reason"];

const STEP_MS = 60_000;
const STATUS = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--ignore-submodules=dirty",
  "--untracked-files=normal",
];
const refuse = (reason: Refusal): CommitResult => ({ ok: false, reason });
const trimSlash = (path: string): string => path.replace(/\/+$/, "");

export interface CommitDeps {
  readonly store: Pick<LanesStore, "getOwned">;
  readonly git: GitRunner;
  /** The git dir pap stored for the lane (MC3 I3). */
  gitDirOf(worktree: string): string | undefined;
  lock(laneId: string): LaneLock;
  /** The lane's facts are read again after a commit; never throws. */
  refresh(laneId: string): Promise<void>;
  publish(laneId: string): void;
  readonly logger: Logger;
  readonly readOnly: boolean;
  /** A nested repository left out of a commit is a notice (a count, never names). */
  readonly notices: Pick<LaneNotices, "add">;
}

export interface Committer {
  commit(caller: Caller, params: ParamsOf<"lanes.commit">): Promise<CommitResult>;
}

/** True when `path` is a staged entry or below one (a folder entry ends with `/`). */
const within = (path: string, scope: readonly string[]): boolean =>
  scope.some((entry) => path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`));

/** What a finished `add` or `commit` says, as the reasons of `lanes.commit` (M9R68). */
export function classifyCommit(run: { stdout: string; stderr: string }): Refusal {
  const text = `${run.stdout}\n${run.stderr}`;
  if (/nothing to commit|no changes added/i.test(text)) return "nothing_to_commit";
  if (/Please tell me who you are|unable to auto-detect email/i.test(text)) return "identity_missing";
  if (/unmerged|conflict/i.test(text)) return "conflicted";
  return "failed";
}

/**
 * The paths a commit stages, taken from the guarded status and never from the client's text alone (MC1 I3, MC2): the
 * chosen files, the changed files under a chosen folder, and a rename's old name; deletions included. A tracked
 * gitlink is left out here. A nested repository that `add` would embed (below an untracked folder at any depth, or
 * chosen itself) is taken out of the index again by `dropNewGitlinks` right after the `add`.
 */
function selectPaths(
  entries: readonly PorcelainEntry[],
  chosen: readonly string[],
): { paths: string[]; renamedFrom: string[]; unmerged: boolean } {
  const out = new Set<string>();
  const renamedFrom = new Set<string>();
  let unmerged = false;
  for (const wanted of chosen) {
    const want = trimSlash(wanted);
    for (const entry of entries) {
      const own = trimSlash(entry.path);
      const matches =
        own === want ||
        entry.origPath === want ||
        own.startsWith(`${want}/`) ||
        (entry.path.endsWith("/") && want.startsWith(`${own}/`));
      if (!matches) continue;
      if (entry.kind === "unmerged") unmerged = true;
      if (entry.submodule.startsWith("S")) continue;
      // A file chosen inside an untracked folder is staged by its own name, not by the whole folder.
      const insideUntracked = entry.path.endsWith("/") && own !== want && want.startsWith(`${own}/`);
      out.add(insideUntracked ? want : entry.path);
      // The old name of a staged rename is not staged again (`add` refuses it), but the commit must name it.
      if (entry.origPath !== null) renamedFrom.add(entry.origPath);
    }
  }
  return { paths: [...out], renamedFrom: [...renamedFrom], unmerged };
}

export function createCommitter(deps: CommitDeps): Committer {
  const { git } = deps;

  async function run(lane: LaneRow, params: ParamsOf<"lanes.commit">, gitDir: string): Promise<CommitResult> {
    const root = lane.worktree;
    const status = parsePorcelainV2((await git.run(root, STATUS, { gitDir })).stdout);
    const { paths, renamedFrom, unmerged } = selectPaths(status.entries, params.paths);
    if (unmerged) return refuse("conflicted");
    if (paths.length === 0) return refuse("nothing_to_commit");
    const staged = stageInput(paths);
    if (staged === null) return refuse("failed");
    const step = { gitDir, timeoutMs: STEP_MS, okCodes: [0, 1, 128], keepStderr: true } as const;
    const text = (done: { stdout: Buffer; stderr?: string }) => ({
      stdout: done.stdout.toString("utf8"),
      stderr: done.stderr ?? "",
    });
    const added = await git.run(root, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      ...step,
      input: staged,
    });
    if (added.code !== 0) return refuse(classifyCommit(text(added)));
    const embedded = await dropNewGitlinks(git, root, gitDir);
    if (embedded.length > 0) deps.notices.add(lane.id, "nested_repo_left_out", embedded.length);
    // What is staged now inside the chosen paths is what the commit names (an embedded repository is gone from it).
    const cached = await git.run(
      root,
      ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--ignore-submodules=dirty"],
      {
        gitDir,
        timeoutMs: STEP_MS,
      },
    );
    const named = new Set<string>();
    for (const entry of parseRawDiff(cached.stdout)) {
      if (!within(entry.path, paths)) continue;
      named.add(entry.path);
      if (entry.oldPath !== null) named.add(entry.oldPath);
    }
    for (const old of renamedFrom) named.add(old);
    if (named.size === 0) return refuse("nothing_to_commit");
    const message = Buffer.from(`${params.message.trimEnd()}\n\nPap-Lane: ${lane.id}\n`, "utf8");
    const committed = await git.run(
      root,
      ["commit", "--file=-", "--no-gpg-sign", "--quiet", "--", ...[...named].map((path) => `./${path}`)],
      { ...step, input: message },
    );
    if (committed.code !== 0) return refuse(classifyCommit(text(committed)));
    const head = await git.run(root, ["rev-parse", "--verify", "HEAD"], { gitDir });
    return { ok: true, oid: head.stdout.toString("utf8").trim() };
  }

  return {
    async commit(caller, params) {
      const lane = deps.store.getOwned(caller.userId, params.laneId);
      if (!lane) throw new PapError("not_found");
      if (deps.readOnly) throw new PapError("read_only");
      const gitDir = deps.gitDirOf(lane.worktree);
      if (lane.state !== "active" || gitDir === undefined) return refuse("failed");
      try {
        // The lane lock keeps a commit from interleaving with a restore or a checkpoint capture (M9R120).
        return await deps.lock(lane.id).run("commit", () => run(lane, params, gitDir));
      } catch (error) {
        if (error instanceof PapError) throw error;
        if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
        if (!(error instanceof GitError))
          deps.logger.warn("lane_commit_failed", { laneId: lane.id, err: error });
        return refuse("failed");
      } finally {
        await deps.refresh(lane.id);
        deps.publish(lane.id);
      }
    },
  };
}
