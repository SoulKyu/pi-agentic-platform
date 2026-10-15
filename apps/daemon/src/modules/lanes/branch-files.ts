import { diffList } from "../../kernel/git/diff-lists.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { snapshotTree } from "../../kernel/git/snapshot.ts";
import type { Logger } from "../../kernel/logger.ts";

/** The kernel git functions a branch list uses, replaceable in tests. */
export interface BranchFilesOps {
  readonly snapshotTree: typeof snapshotTree;
  readonly diffList: typeof diffList;
}

type DiffList = Awaited<ReturnType<typeof diffList>>;

/**
 * The branch list shared by the Review pane (M9R85) and the compare columns: `merge-base` of the base and HEAD, a
 * snapshot of the files now, and the diff list between the two. One place, so the two views count the same files.
 */
export async function branchFiles(
  git: GitRunner,
  worktree: string,
  gitDir: string,
  baseRef: string,
  baseOid: string,
  indexDir: string,
  logger: Logger,
  ops: BranchFilesOps = { snapshotTree, diffList },
): Promise<DiffList & { readonly base: string; readonly tree: string }> {
  // `baseRef` starts with a letter or `refs/` (BRANCH_PATTERN), so it cannot read as an option. A base branch that was
  // deleted or renamed no longer resolves: the lane was cut from `baseOid`, which stays the base then.
  const base = await git.run(worktree, ["merge-base", baseRef, "HEAD"], { gitDir }).then(
    (done) => done.stdout.toString("utf8").trim(),
    (error: unknown) => {
      if (error instanceof GitError && error.kind === "failed") return baseOid;
      throw error;
    },
  );
  const { tree } = await ops.snapshotTree(git, worktree, gitDir, indexDir);
  return { base, tree, ...(await ops.diffList(git, worktree, gitDir, base, tree, logger)) };
}
