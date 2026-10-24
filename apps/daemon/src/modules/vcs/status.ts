import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildStatus,
  emptyStatus,
  GIT_NUMSTAT_ARGS,
  GIT_STATUS_ARGS,
  parseNumstat,
  parsePorcelainV2,
  type VcsStatus,
} from "@pap/contracts";
import { judgeName, type Scope } from "../../kernel/fs/boundary.ts";
import { GitError, type GitErrorKind, type GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LineCounter } from "./line-counts.ts";

export { emptyStatus };

export interface StatusDeps {
  readonly git: GitRunner;
  readonly logger: Logger;
  now(): number;
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
  const parsed = parsePorcelainV2((await deps.git.run(root, GIT_STATUS_ARGS)).stdout);
  // An unborn branch has no HEAD to compare with.
  const numstat =
    parsed.branch.oid === null ? null : parseNumstat((await deps.git.run(root, GIT_NUMSTAT_ARGS)).stdout);
  counter?.beginRun();
  return buildStatus({
    root,
    at,
    parsed,
    numstat,
    count: counter === null ? null : (path) => counter.count(path),
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
