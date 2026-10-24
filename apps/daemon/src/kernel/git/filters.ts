/**
 * MC13 (M7 rebase item 4): a repository's own `filter.<name>.{clean,smudge,process}` is a program `git status` and
 * `git diff` run on the files they compare. The runner asks git which drivers the repository's config defines, then
 * runs the real command with those drivers emptied (`GIT_CONFIG_COUNT` entries, which carry any name, `=` included).
 * The Review pane keeps working; nothing the repository named runs. Written to `docs/agents/files.md`.
 *
 * Not neutralised: the owner's own system and global config (his, as in M7's repository config guard), and the exact
 * standard git-lfs entries, which run the git-lfs binary and nothing the repository chose.
 */
import { execFile } from "node:child_process";
import { disablingEnv, driversToDisable, MAX_FILTER_DRIVERS } from "@pap/contracts";
import { FILTER_SCAN_ARGS, gitEnv } from "./exec.ts";
import { GitError, type GitRunner } from "./runner.ts";

/** Subcommands that compare, hash or check out working-tree files and so run clean or smudge filters. */
export const FILTERING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  // M9R13: they hash or check out working-tree files, so a repository's own clean or smudge filter would run.
  "add",
  "commit",
  "restore",
  "reset",
  "worktree",
  // Writing the index re-hashes a racily clean entry through its clean filter (reproduced on git 2.53, Task 11).
  "write-tree",
]);

export { disablingEnv, driversToDisable, MAX_FILTER_DRIVERS };

/** `GIT_CONFIG_COUNT/KEY/VALUE` (the overrides) need git 2.31; `--show-scope` (the scan) needs 2.26. */
export const OVERRIDES_FROM: readonly [number, number] = [2, 31];
export const SCAN_FROM: readonly [number, number] = [2, 26];

export function parseGitVersion(text: string): readonly [number, number] {
  const match = /git version (\d+)\.(\d+)/.exec(text);
  // Unreadable: treated as the oldest, so nothing is run unchecked.
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}
const atLeast = (version: readonly [number, number], floor: readonly [number, number]): boolean =>
  version[0] > floor[0] || (version[0] === floor[0] && version[1] >= floor[1]);

/** `git --version` with the daemon's absolute PATH entries and nothing else of its environment. */
const gitVersionText = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--version"],
      { env: { PATH: gitEnv(process.env, "/").PATH ?? "", LC_ALL: "C" } },
      (error, stdout) => {
        if (error) {
          reject(
            (error as { code?: unknown }).code === "ENOENT"
              ? new GitError("git_missing")
              : new GitError("failed"),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface GuardOptions {
  /** `git --version` output; replaced in tests. Asked once, and again only after a failure. */
  readonly gitVersion?: () => Promise<string>;
}

/**
 * The runner for production: `status` and `diff` first learn the repository's filter drivers, then run with them
 * emptied. Two calls, each under the raw runner's own process cap.
 *
 * ponytail: each status or diff costs a scan, so a poll tick starts 4 git processes, not 2. If poll cost shows, scan
 * once per tick (or cache by the config files' mtimes) and hand the result to both calls.
 *
 * Below git 2.31 the overrides are silently ignored: a repository with non-lfs drivers is refused (`git_too_old`);
 * below 2.26 the scan itself does not exist, so every status and diff is refused.
 */
export function guardFilters(raw: GitRunner, options: GuardOptions = {}): GitRunner {
  let version: Promise<readonly [number, number]> | null = null;
  const versionOnce = (): Promise<readonly [number, number]> => {
    version ??= (options.gitVersion ?? gitVersionText)().then(parseGitVersion);
    version.catch(() => {
      version = null;
    });
    return version;
  };
  return {
    async run(root, args, runOptions = {}) {
      if (!FILTERING_SUBCOMMANDS.has(args[0] ?? "")) return raw.run(root, args, runOptions);
      const found = await versionOnce();
      if (!atLeast(found, SCAN_FROM)) throw new GitError("git_too_old");
      const scan = await raw.run(root, FILTER_SCAN_ARGS, {
        okCodes: [0, 1],
        timeoutMs: runOptions.timeoutMs ?? 10_000,
        // MC1 I4: the scan reads the config of the git dir the call will use, not the one a `.git` file names.
        ...(runOptions.gitDir === undefined ? {} : { gitDir: runOptions.gitDir }),
      });
      const drivers = driversToDisable(scan.stdout);
      if (drivers === null) throw new GitError("failed");
      if (drivers.length > 0 && !atLeast(found, OVERRIDES_FROM)) throw new GitError("git_too_old");
      return raw.run(root, args, { ...runOptions, env: { ...runOptions.env, ...disablingEnv(drivers) } });
    },
  };
}
