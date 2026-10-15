import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { BRANCH_PATTERN, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import { laneFolder, readAdminDir, WORKTREES_DIR } from "./paths.ts";
import { createTeardown } from "./recover.ts";
import { createRepoLock } from "./repo-lock.ts";
import { createWorktreesStore, type NewWorktree, type WorktreeRow } from "./store.ts";

export type WorktreeStep = "disk" | "git" | "prepare";

/** Phase 2 or the caller's prepare step failed and was undone: the lane turns it into `failed` with this step. */
export class WorktreeFailure extends Error {
  readonly step: WorktreeStep;

  constructor(step: WorktreeStep) {
    super(`worktree ${step} step failed`);
    this.name = "WorktreeFailure";
    this.step = step;
  }
}

export interface WorktreesDeps {
  readonly db: Db;
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly papHome: string;
  readonly readOnly: boolean;
  /** Throws when `path`'s filesystem is too full for a checkout (M9R117). */
  diskFloor(path: string): undefined;
}

export interface WorktreesPort {
  /** Phase 1, one transaction: caps, `check` (the lane count, Task 6b), then the row `creating`. */
  reserve(ownerId: string, row: NewWorktree, check: (tx: Db) => void): void;
  /** Phase 2, under the repository's lock; any failure undoes inline and rejects with a `WorktreeFailure`. */
  create(path: string): Promise<void>;
  ready(path: string): Promise<void>;
  /** The caller's own step failed after `create`: the same undo as recovery. Idempotent. */
  undo(path: string): Promise<void>;
  remove(input: { path: string; force: boolean }): Promise<{ ok: true } | { ok: false; reason: "dirty" }>;
  /** Always git's `-d` (M9R19, final review I3): Force is about the worktree; commits neither merged nor pushed keep their branch and this answers false. */
  deleteBranch(input: { repoRoot: string; branch: string }): Promise<boolean>;
  /** The lane's git dir as git created and pap checked it: the only source for lane git calls (MC3 I3, Tasks 11 and 14). */
  gitDirOf(path: string): string | undefined;
  byPath(path: string): WorktreeRow | undefined;
  forOwner(ownerId: string): readonly WorktreeRow[];
  recover(): Promise<void>;
}

const ADD_DEADLINE_MS = 120_000;

export function createWorktreesService(deps: WorktreesDeps): WorktreesPort {
  const { git, clock, logger, papHome } = deps;
  const store = createWorktreesStore(deps.db);
  const lock = createRepoLock(git);
  const teardown = createTeardown({ git, store, lock, logger, papHome });
  const readOnlyGuard = (): void => {
    if (deps.readOnly) throw new PapError("read_only");
  };

  /** M9R16: the worktrees folder is a real directory (0700), and the lane's own folder does not exist yet. */
  function prepareFolder(path: string): string {
    const root = join(realpathSync(papHome), WORKTREES_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const info = lstatSync(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("worktrees is not a directory");
    chmodSync(root, 0o700);
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
      throw error;
    }
    throw new Error("lane folder exists");
  }

  const mustBe = (path: string, state: WorktreeRow["state"]): WorktreeRow => {
    const row = store.get(path);
    if (!row || row.state !== state) throw new PapError("not_found");
    return row;
  };

  /** Undo inline, then reject: the row is gone, so the owner's creating slot is free at once (M9-RT-03). */
  async function failed(row: WorktreeRow, step: WorktreeStep): Promise<never> {
    try {
      await teardown.undo(row);
    } catch (error) {
      logger.error("worktree_undo_failed", { step, err: error });
      store.delete(row.path);
    }
    throw new WorktreeFailure(step);
  }

  /** The dirty check: the stored git dir (MC3 I3), the pinned work tree (MC3 I2) and untracked files always shown (MC3 I1). */
  async function isDirty(row: WorktreeRow): Promise<boolean> {
    try {
      lstatSync(row.path);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    try {
      if (row.gitDir === null) return true;
      const { stdout } = await git.run(
        row.path,
        ["status", "--porcelain=v2", "-z", "--ignore-submodules=dirty", "--untracked-files=normal"],
        { gitDir: row.gitDir },
      );
      return stdout.length > 0;
    } catch {
      // Git cannot say: not clean enough to delete without the person's force.
      return true;
    }
  }

  return {
    reserve(ownerId, row, check) {
      readOnlyGuard();
      if (laneFolder(papHome, basename(row.path)) !== row.path) throw new Error("not a lane folder");
      if (!BRANCH_PATTERN.test(row.branch)) throw new Error("not a branch name");
      store.reserve(ownerId, row, clock.now(), check);
    },

    async create(path) {
      const row = mustBe(path, "creating");
      // Nothing was created yet by git: a refusal here frees the row and needs no undo.
      let root: string;
      try {
        root = prepareFolder(path);
      } catch (error) {
        logger.warn("worktree_folder_unusable", { err: error });
        store.delete(path);
        throw new WorktreeFailure("git");
      }
      try {
        deps.diskFloor(root);
      } catch (error) {
        logger.warn("worktree_disk_refused", { err: error });
        store.delete(path);
        throw new WorktreeFailure("disk");
      }
      try {
        await lock.run(row.repoRoot, async (commonDir) => {
          if (row.createdBranch)
            await git.run(row.repoRoot, ["branch", "--no-track", row.branch, row.baseOid]);
          await git.run(
            row.repoRoot,
            ["worktree", "add", "--lock", "--reason=pap-creating", path, row.branch],
            {
              env: { GIT_LFS_SKIP_SMUDGE: "1" },
              timeoutMs: ADD_DEADLINE_MS,
            },
          );
          // MC3 I3: read back and checked under the same lock, before anything else touches the repository.
          store.setGitDir(path, readAdminDir(path, commonDir));
        });
      } catch {
        return failed(row, "git");
      }
    },

    async ready(path) {
      const row = mustBe(path, "creating");
      try {
        await lock.run(row.repoRoot, () => git.run(row.repoRoot, ["worktree", "unlock", path]));
      } catch {
        return failed(row, "git");
      }
      store.setState(path, "ready", clock.now());
    },

    async undo(path) {
      const row = store.get(path);
      if (row) await teardown.undo(row);
    },

    async remove({ path, force }) {
      const row = store.get(path);
      if (!row) return { ok: true };
      readOnlyGuard();
      if (!force && (await isDirty(row))) return { ok: false, reason: "dirty" };
      store.setState(path, "removing", clock.now());
      await teardown.dismantle(row);
      return { ok: true };
    },

    async deleteBranch({ repoRoot, branch }) {
      if (!BRANCH_PATTERN.test(branch)) return false;
      try {
        await lock.run(repoRoot, () => git.run(repoRoot, ["branch", "-d", branch]));
        return true;
      } catch {
        return false;
      }
    },

    gitDirOf: (path) => store.get(path)?.gitDir ?? undefined,
    byPath: (path) => store.get(path),
    forOwner: (ownerId) => store.forOwner(ownerId),
    recover: () => teardown.recover(deps.readOnly),
  };
}
