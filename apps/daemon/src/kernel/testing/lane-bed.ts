import { join } from "node:path";
import { createGitRunner, type GitRunner } from "../git/runner.ts";
import { guardFilters } from "../git/filters.ts";
import { silentLogger } from "../logger.ts";
import { createGitBed, type GitBed } from "./git-bed.ts";

export interface LaneBed {
  bed: GitBed;
  /** The production stack: the guarded runner, with a temporary-index folder. */
  git: GitRunner;
  indexDir: string;
  /** Creates a lane worktree on a new branch and answers its path and the git dir pap would have stored. */
  lane(name: string): Promise<{ path: string; gitDir: string }>;
  dispose(): void;
}

/** A repository with one commit and the runner the lane code uses, for the checkpoint tests (real git, temporary HOME). */
export function createLaneBed(): LaneBed {
  const bed = createGitBed();
  const indexDir = join(bed.dir, "git-index");
  const raw = createGitRunner({
    env: { PATH: process.env.PATH, HOME: bed.home },
    logger: silentLogger,
    indexDir,
  });
  const git = guardFilters(raw);
  return {
    bed,
    git,
    indexDir,
    async lane(name) {
      const path = join(bed.dir, name);
      const head = bed.git(bed.root, "rev-parse", "HEAD").trim();
      await git.run(bed.root, ["branch", "--no-track", `pi/${name}`, head]);
      await git.run(bed.root, ["worktree", "add", "--lock", "--reason=pap-creating", path, `pi/${name}`]);
      return { path, gitDir: join(bed.root, ".git", "worktrees", name) };
    },
    dispose: () => bed.dispose(),
  };
}
