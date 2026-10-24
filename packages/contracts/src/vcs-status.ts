import type { NumstatRow } from "./git-numstat.ts";
import type { PorcelainEntry, PorcelainStatus } from "./git-porcelain.ts";
import { PAGE_BYTES, sizeOf } from "./json-bytes.ts";
import { RepoPath, VCS_LIMITS, type VcsFile, type VcsStatus } from "./vcs.ts";

// No `--untracked-files`: the repository's own setting decides, `normal` by default, so an untracked folder is one
// `dir/` entry and `status.showUntrackedFiles=no` lists none (M8R46).
export const GIT_STATUS_ARGS = ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"];
export const GIT_NUMSTAT_ARGS = [
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

/** At most `max` UTF-16 units (what `z.string().max` counts), never ending on the first half of a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

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

/** Lines of an untracked text file; additions null for a binary file, one too large to count, or one that may not be read. */
export interface LineCount {
  readonly additions: number | null;
  readonly binary: boolean;
}

async function fileOf(
  entry: PorcelainEntry,
  numstat: ReadonlyMap<string, NumstatRow> | null,
  count: ((path: string) => Promise<LineCount>) | null,
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
    const counted = folder || count === null ? null : await count(path);
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

/**
 * The snapshot of a repository from git's own answers (M8R46), whoever ran git: the daemon on a host project, the guest in a
 * box. `numstat` is null on an unborn branch; `count` null reads no file for line counts.
 */
export async function buildStatus(input: {
  readonly root: string;
  readonly at: number;
  readonly parsed: PorcelainStatus;
  readonly numstat: ReadonlyMap<string, NumstatRow> | null;
  readonly count: ((path: string) => Promise<LineCount>) | null;
}): Promise<VcsStatus> {
  const { parsed, numstat, count } = input;
  const { kept, cut } = selectEntries(parsed.entries);
  const files: VcsFile[] = [];
  for (const entry of kept) files.push(await fileOf(entry, numstat, count));
  const { branch } = parsed;
  return fitted({
    root: input.root,
    repo: true,
    branch: branch.head === null ? null : cutText(branch.head, BRANCH_CHARS),
    detached: branch.detached,
    upstream: branch.upstream === null ? null : cutText(branch.upstream, UPSTREAM_CHARS),
    ahead: branch.ahead ?? 0,
    behind: branch.behind ?? 0,
    files,
    truncated: cut,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    at: input.at,
    error: null,
  });
}
