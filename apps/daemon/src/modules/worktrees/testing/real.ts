import { createGitBed, type GitBed } from "../../../kernel/testing/git-bed.ts";
import { guardFilters } from "../../../kernel/git/filters.ts";
import type { GitRunner } from "../../../kernel/git/runner.ts";
import { createWorktreesModule, type WorktreesPort } from "../index.ts";
import { createWorktreesBed, type WorktreesBed } from "./bed.ts";

export interface RealBed {
  readonly worktrees: WorktreesBed;
  readonly repo: GitBed;
  readonly git: GitRunner;
  readonly base: string;
  /** A module over the real runner (a fresh one models a restart). */
  module(overrides?: { readOnly?: boolean; git?: GitRunner }): WorktreesPort;
  /** Phase 1 for `laneId`; returns the lane's folder. */
  reserve(module: WorktreesPort, laneId: string): string;
  dispose(): void;
}

/** A real repository with one commit, a pap home and a database, for the tests that run real git. */
export function createRealBed(): RealBed {
  const repo = createGitBed();
  const worktrees = createWorktreesBed();
  const git = guardFilters(repo.runner());
  const base = repo.git(repo.root, "rev-parse", "HEAD").trim();
  return {
    worktrees,
    repo,
    git,
    base,
    module: (overrides = {}) =>
      createWorktreesModule({
        db: worktrees.db,
        git: overrides.git ?? git,
        clock: worktrees.clock,
        logger: worktrees.logger,
        papHome: worktrees.papHome,
        readOnly: overrides.readOnly ?? false,
        diskFloor: () => undefined,
      }),
    reserve(module, laneId) {
      const path = worktrees.folder(laneId);
      module.reserve(
        "o1",
        {
          path,
          workspaceId: "default",
          repoRoot: repo.root,
          branch: `pap/${laneId}`,
          baseOid: base,
          createdBranch: true,
        },
        () => {},
      );
      return path;
    },
    dispose() {
      worktrees.dispose();
      repo.dispose();
    },
  };
}
