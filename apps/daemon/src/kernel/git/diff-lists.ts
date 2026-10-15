import { INVISIBLE, LANE_LIMITS, RepoPath } from "@pap/contracts";
import type { Logger } from "../logger.ts";
import { parseNumstat } from "./numstat.ts";
import type { GitRunner } from "./runner.ts";

export const MAX_REVIEW_FILES = LANE_LIMITS.reviewFiles;
const LIST_MAX_BYTES = 16 * 1024 * 1024;
const LIST_TIMEOUT_MS = 60_000;

export interface RawEntry {
  readonly oldMode: string;
  readonly newMode: string;
  readonly newSha: string;
  /** The status letter alone: the rename score is dropped. */
  readonly status: string;
  readonly path: string;
  readonly oldPath: string | null;
}

/** `git diff --raw -z`: `:oldmode newmode oldsha newsha STATUS NUL path NUL`, a rename or copy adds a second path. */
export function parseRawDiff(out: Buffer, encoding: "utf8" | "latin1" = "utf8"): RawEntry[] {
  // latin1 keeps every byte of a path (a name that is not UTF-8) and `Buffer.from(path, "latin1")` gives it back.
  const tokens = out.toString(encoding).split("\0");
  const entries: RawEntry[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(tokens[at] ?? "");
    if (!meta) continue;
    const twoPaths = meta[5] === "R" || meta[5] === "C";
    const first = tokens[at + 1];
    const second = tokens[at + 2];
    if (first === undefined || first === "" || (twoPaths && (second === undefined || second === "")))
      continue;
    at += twoPaths ? 2 : 1;
    entries.push({
      oldMode: meta[1] as string,
      newMode: meta[2] as string,
      newSha: meta[4] as string,
      status: meta[5] as string,
      path: twoPaths ? (second as string) : first,
      oldPath: twoPaths ? first : null,
    });
  }
  return entries;
}

const REVIEW_STATUS = new Set(["A", "M", "D", "R", "C", "T"]);
const usable = (path: string): boolean => RepoPath.safeParse(path).success && !INVISIBLE.test(path);

export interface ReviewFileRow {
  path: string;
  oldPath: string | null;
  status: "A" | "M" | "D" | "R" | "C" | "T";
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** The to-side blob, or `deleted`. */
  identity: string;
}

/**
 * M9R56: `--raw` gives the status and the blob, `--numstat` the counts and the binary flag; they are joined by path.
 * A path that is not a repository path, or holds an invisible character, is dropped and counted in one log line.
 */
export function mergeDiffLists(
  rawOut: Buffer,
  numstatOut: Buffer,
  logger: Logger,
): { files: ReviewFileRow[]; truncated: boolean } {
  const counts = parseNumstat(numstatOut);
  const files: ReviewFileRow[] = [];
  let dropped = 0;
  let truncated = false;
  for (const entry of parseRawDiff(rawOut)) {
    if (!REVIEW_STATUS.has(entry.status)) continue;
    if (!usable(entry.path) || (entry.oldPath !== null && !usable(entry.oldPath))) {
      dropped += 1;
      continue;
    }
    if (files.length >= MAX_REVIEW_FILES) {
      truncated = true;
      continue;
    }
    const row = counts.get(entry.path);
    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status as ReviewFileRow["status"],
      additions: row?.additions ?? null,
      deletions: row?.deletions ?? null,
      binary: row !== undefined && row.additions === null && row.deletions === null,
      identity: entry.status === "D" ? "deleted" : entry.newSha,
    });
  }
  if (dropped > 0) logger.warn("review_path_dropped", { count: dropped });
  return { files, truncated };
}

/** The files that differ between two commits or trees, for the Review pane (M9R56). Never follows an external diff or a textconv. */
export async function diffList(
  git: GitRunner,
  root: string,
  gitDir: string,
  from: string,
  to: string,
  logger: Logger,
): Promise<{ files: ReviewFileRow[]; truncated: boolean }> {
  const options = { gitDir, maxBytes: LIST_MAX_BYTES, timeoutMs: LIST_TIMEOUT_MS };
  const raw = await git.run(root, ["diff", "--raw", "-z", "-M", "--no-abbrev", from, to, "--"], options);
  const numstat = await git.run(root, ["diff", "--numstat", "-z", "-M", from, to, "--"], options);
  return mergeDiffLists(raw.stdout, numstat.stdout, logger);
}
