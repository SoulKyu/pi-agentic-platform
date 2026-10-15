import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import { removeLaneFolder } from "./paths.ts";
import type { RepoLock } from "./repo-lock.ts";
import type { WorktreeRow, WorktreesStore } from "./store.ts";

export interface TeardownDeps {
  readonly git: GitRunner;
  readonly store: WorktreesStore;
  readonly lock: RepoLock;
  readonly logger: Logger;
  readonly papHome: string;
}

export interface Teardown {
  /** Phase-2 undo, inline and at boot (M9R20): registration, folder, the branch only if still at its base, the row. */
  undo(row: WorktreeRow): Promise<void>;
  /** Removal: the same registration and folder steps, the branch kept, then the row. */
  dismantle(row: WorktreeRow): Promise<void>;
  /** Finishes or undoes whatever a crash left in `creating` or `removing`. */
  recover(readOnly: boolean): Promise<void>;
}

const ignored = async (call: Promise<unknown>): Promise<void> => {
  try {
    await call;
  } catch {
    // Best effort: an unlocked or unknown worktree answers 128, and the steps after it settle the rest.
  }
};

export function createTeardown(deps: TeardownDeps): Teardown {
  const { git, store, lock, logger, papHome } = deps;

  async function knows(row: WorktreeRow): Promise<boolean> {
    try {
      const { stdout } = await git.run(row.repoRoot, ["worktree", "list", "--porcelain", "-z"]);
      return stdout.toString("utf8").split("\0").includes(`worktree ${row.path}`);
    } catch {
      return false;
    }
  }

  async function folderGone(row: WorktreeRow): Promise<void> {
    if (!(await removeLaneFolder(papHome, row.path))) logger.warn("worktree_folder_refused");
  }

  /** M9-RT-03: a locked worktree is neither removed nor pruned, so it is unlocked first. */
  async function registration(row: WorktreeRow): Promise<void> {
    if (await knows(row)) {
      await ignored(git.run(row.repoRoot, ["worktree", "unlock", row.path]));
      await ignored(git.run(row.repoRoot, ["worktree", "remove", "--force", row.path]));
    }
    await folderGone(row);
    await ignored(git.run(row.repoRoot, ["worktree", "prune"]));
  }

  /** The branch goes only when pap made it and it still points at the commit it was made at: no commit is lost. */
  async function branchAtBase(row: WorktreeRow): Promise<void> {
    if (!row.createdBranch) return;
    try {
      const { stdout } = await git.run(
        row.repoRoot,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${row.branch}^{commit}`],
        { okCodes: [0, 1] },
      );
      const tip = stdout.toString("utf8").trim();
      if (tip === "") return;
      if (tip !== row.baseOid) {
        logger.warn("worktree_branch_kept", { reason: "moved" });
        return;
      }
      await git.run(row.repoRoot, ["branch", "-D", row.branch]);
    } catch {
      logger.warn("worktree_branch_kept", { reason: "git" });
    }
  }

  async function takeApart(row: WorktreeRow, withBranch: boolean): Promise<void> {
    try {
      await lock.run(row.repoRoot, async () => {
        await registration(row);
        if (withBranch) await branchAtBase(row);
      });
    } catch {
      // The repository itself is unreachable (moved, deleted): the folder still goes, and the branch is kept.
      logger.warn("worktree_git_unavailable");
      await folderGone(row);
    }
    store.delete(row.path);
  }

  return {
    undo: (row) => takeApart(row, true),
    dismantle: (row) => takeApart(row, false),
    async recover(readOnly) {
      if (readOnly) {
        logger.info("worktree_recovery_skipped");
        return;
      }
      for (const row of store.unfinished()) {
        try {
          await takeApart(row, row.state === "creating");
          logger.info("worktree_recovered", { step: row.state });
        } catch (error) {
          logger.error("worktree_recovery_failed", { step: row.state, err: error });
        }
      }
    },
  };
}
