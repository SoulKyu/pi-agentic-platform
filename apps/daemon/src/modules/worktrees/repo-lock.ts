import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { GitRunner } from "../../kernel/git/runner.ts";

export interface RepoLock {
  /** The real path of the repository's common git dir, which is what the lock is keyed on. */
  commonDir(repoRoot: string): Promise<string>;
  /** Runs `fn` after every earlier call on the same repository settled (M9R18); `fn` gets the common dir. */
  run<T>(repoRoot: string, fn: (commonDir: string) => Promise<T>): Promise<T>;
}

const noop = (): void => undefined;

/**
 * One in-memory promise chain per repository (M9R18): git's own `index.lock` and `worktrees/` writes race otherwise.
 * Keyed by the real path of `rev-parse --git-common-dir`, so two roots of one repository share a chain.
 */
export function createRepoLock(git: GitRunner): RepoLock {
  const tails = new Map<string, Promise<void>>();
  const commonDir = async (repoRoot: string): Promise<string> => {
    const { stdout } = await git.run(repoRoot, ["rev-parse", "--git-common-dir"]);
    return realpathSync(resolve(repoRoot, stdout.toString("utf8").trim()));
  };
  return {
    commonDir,
    async run(repoRoot, fn) {
      const key = await commonDir(repoRoot);
      const result = (tails.get(key) ?? Promise.resolve()).then(() => fn(key));
      const tail = result.then(noop, noop);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}
