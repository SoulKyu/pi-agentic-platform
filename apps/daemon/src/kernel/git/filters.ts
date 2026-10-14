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
import { LFS_ENTRIES } from "@pap/contracts";
import { FILTER_SCAN_ARGS, gitEnv } from "./exec.ts";
import { GitError, type GitRunner } from "./runner.ts";

/** Subcommands that compare working-tree files and so run clean filters. */
export const FILTERING_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff"]);

const OWNERS_OWN_SCOPES: ReadonlySet<string> = new Set(["system", "global"]);
const PROGRAM_KEY = /^filter\.(.*)\.(clean|smudge|process)$/;
/** A repository with more drivers than this is not ordinary: the call is refused (the environment has a size limit). */
export const MAX_FILTER_DRIVERS = 64;

/** The drivers to empty, or null when there are too many to name. */
export function driversToDisable(scan: Buffer): string[] | null {
  const fields = scan.toString("utf8").split("\0");
  const names = new Set<string>();
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const scope = fields[at] as string;
    const entry = fields[at + 1] as string;
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? null : entry.slice(newline + 1);
    const program = PROGRAM_KEY.exec(key);
    if (program === null || OWNERS_OWN_SCOPES.has(scope)) continue;
    const [, name, kind] = program as unknown as [string, string, string];
    // One entry that is not the standard one empties the whole `lfs` driver.
    if (!(name === "lfs" && value !== null && LFS_ENTRIES.get(kind) === value)) names.add(name);
  }
  if (names.size > MAX_FILTER_DRIVERS) return null;
  return [...names];
}

/** `GIT_CONFIG_COUNT` entries that empty each driver and stop `required` from failing the call. */
export function disablingEnv(names: readonly string[]): Record<string, string> {
  const entries = names.flatMap((name): Array<[string, string]> => [
    [`filter.${name}.clean`, ""],
    [`filter.${name}.smudge`, ""],
    [`filter.${name}.process`, ""],
    [`filter.${name}.required`, "false"],
  ]);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], at) => {
    env[`GIT_CONFIG_KEY_${at}`] = key;
    env[`GIT_CONFIG_VALUE_${at}`] = value;
  });
  return env;
}

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
      });
      const drivers = driversToDisable(scan.stdout);
      if (drivers === null) throw new GitError("failed");
      if (drivers.length > 0 && !atLeast(found, OVERRIDES_FROM)) throw new GitError("git_too_old");
      return raw.run(root, args, { ...runOptions, env: { ...runOptions.env, ...disablingEnv(drivers) } });
    },
  };
}
