import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { RepoPath, VCS_LIMITS, type VcsFile, type VcsStatus } from "@pap/contracts";
import { judgeName, type Scope } from "../../kernel/fs/boundary.ts";
import { GitError, type GitErrorKind, type GitRunner } from "../../kernel/git/runner.ts";
import { type NumstatRow, parseNumstat } from "../../kernel/git/numstat.ts";
import { type PorcelainEntry, parsePorcelainV2 } from "../../kernel/git/porcelain.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cutUnits } from "../../kernel/text.ts";
import type { LineCounter } from "./line-counts.ts";

export interface StatusDeps {
  readonly git: GitRunner;
  readonly logger: Logger;
  now(): number;
}

// No `--untracked-files`: the repository's own setting decides, `normal` by default, so an untracked folder is one
// `dir/` entry and `status.showUntrackedFiles=no` lists none (M8R46).
const STATUS_ARGS = ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"];
const NUMSTAT_ARGS = [
  "diff",
  "--numstat",
  "-z",
  "--ignore-submodules=dirty",
  "--no-ext-diff",
  "--no-textconv",
  "HEAD",
  "--",
];
const BRANCH_CHARS = 256;
const UPSTREAM_CHARS = 512;

/** What a client is shown when git could not answer (or the folder is no repository): the root and an empty list. */
export function emptyStatus(root: string, at: number, repo: boolean, error: VcsStatus["error"]): VcsStatus {
  return {
    root,
    repo,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false,
    additions: 0,
    deletions: 0,
    at,
    error,
  };
}

function kindOf(entry: PorcelainEntry): VcsFile["kind"] {
  switch (entry.kind) {
    case "untracked":
      return "untracked";
    case "unmerged":
      return "conflicted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    case "ordinary": {
      const letters = `${entry.index}${entry.worktree}`;
      if (entry.index === "A") return "added";
      if (letters.includes("D")) return "deleted";
      return letters.includes("T") ? "typechange" : "modified";
    }
  }
}

const valid = (path: string): boolean => RepoPath.safeParse(path).success;

/** The files of a run: git's order, at most 2 000, a path the schema would refuse left out (and the list marked cut). */
function selectEntries(entries: readonly PorcelainEntry[]): { kept: PorcelainEntry[]; cut: boolean } {
  const kept: PorcelainEntry[] = [];
  let cut = false;
  for (const entry of entries) {
    const path = entry.kind === "untracked" ? entry.path.replace(/\/$/, "") : entry.path;
    if (!valid(path) || (entry.origPath !== null && !valid(entry.origPath))) cut = true;
    else if (kept.length >= VCS_LIMITS.files) cut = true;
    else kept.push(entry);
  }
  return { kept, cut };
}

async function fileOf(
  entry: PorcelainEntry,
  numstat: ReadonlyMap<string, NumstatRow> | null,
  counter: LineCounter | null,
): Promise<VcsFile> {
  const folder = entry.kind === "untracked" && entry.path.endsWith("/");
  const path = folder ? entry.path.slice(0, -1) : entry.path;
  const base = {
    path,
    oldPath: entry.origPath,
    folder,
    index: entry.index,
    worktree: entry.worktree,
    kind: kindOf(entry),
  };
  if (entry.kind === "untracked") {
    const counted = folder || counter === null ? null : await counter.count(path);
    return {
      ...base,
      additions: counted?.additions ?? null,
      deletions: counted === null || counted.additions === null ? null : 0,
      binary: counted?.binary ?? false,
    };
  }
  const row = numstat?.get(path);
  return {
    ...base,
    additions: row?.additions ?? null,
    deletions: row?.deletions ?? null,
    binary: row !== undefined && row.additions === null,
  };
}

/** The longest prefix of the files that keeps the event under `PAGE_BYTES`: the hub does not fit events (M8R110). */
function fitted(status: VcsStatus): VcsStatus {
  const sizeOfEvent = (given: VcsStatus): number => sizeOf({ kind: "snapshot", status: given });
  if (sizeOfEvent(status) <= PAGE_BYTES) return status;
  const cut: VcsStatus = { ...status, truncated: true, files: [] };
  let size = sizeOfEvent(cut);
  const files: VcsFile[] = [];
  for (const file of status.files) {
    const next = size + sizeOf(file) + (files.length > 0 ? 1 : 0);
    if (next > PAGE_BYTES) break;
    files.push(file);
    size = next;
  }
  return { ...cut, files };
}

async function hasGitEntry(root: string): Promise<boolean> {
  try {
    await lstat(join(root, ".git"));
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function assemble(deps: StatusDeps, root: string, counter: LineCounter | null): Promise<VcsStatus> {
  const at = deps.now();
  const parsed = parsePorcelainV2((await deps.git.run(root, STATUS_ARGS)).stdout);
  // An unborn branch has no HEAD to compare with.
  const numstat =
    parsed.branch.oid === null ? null : parseNumstat((await deps.git.run(root, NUMSTAT_ARGS)).stdout);
  const { kept, cut } = selectEntries(parsed.entries);
  counter?.beginRun();
  const files: VcsFile[] = [];
  for (const entry of kept) files.push(await fileOf(entry, numstat, counter));
  const { branch } = parsed;
  return fitted({
    root,
    repo: true,
    branch: branch.head === null ? null : cutUnits(branch.head, BRANCH_CHARS),
    detached: branch.detached,
    upstream: branch.upstream === null ? null : cutUnits(branch.upstream, UPSTREAM_CHARS),
    ahead: branch.ahead ?? 0,
    behind: branch.behind ?? 0,
    files,
    truncated: cut,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    at,
    error: null,
  });
}

/**
 * One status run (M8R46). It never throws: a folder without `.git` is `repo: false` and starts no git, a git failure
 * fills `error` (the runner has logged its details), anything else is `failed` and logged here.
 * `counter` null reads no file for line counts (the poll after a timeout, M8R45).
 */
export async function readStatus(
  deps: StatusDeps,
  root: string,
  counter: LineCounter | null,
): Promise<VcsStatus> {
  try {
    if (!(await hasGitEntry(root))) return emptyStatus(root, deps.now(), false, null);
    return await assemble(deps, root, counter);
  } catch (error) {
    const kind: GitErrorKind = error instanceof GitError ? error.kind : "failed";
    if (!(error instanceof GitError))
      deps.logger.warn("vcs_status_failed", {
        code: (error as { code?: unknown } | null)?.code ?? "unknown",
      });
    if (kind === "git_too_old") deps.logger.warn("vcs_git_too_old", {});
    return emptyStatus(root, deps.now(), kind !== "git_missing", kind === "git_too_old" ? "failed" : kind);
  }
}

/**
 * The status as a scope may see it (MC24): an entry whose path or old path the scope's name judgement refuses is dropped,
 * and the totals are those of what is left. The owner's view is the status itself.
 */
export function restrictStatus(status: VcsStatus, scope: Scope): VcsStatus {
  const allowed = (path: string): boolean => judgeName(join(status.root, path), scope) === null;
  const files = status.files.filter(
    (file) => allowed(file.path) && (file.oldPath === null || allowed(file.oldPath)),
  );
  return {
    ...status,
    files,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}
