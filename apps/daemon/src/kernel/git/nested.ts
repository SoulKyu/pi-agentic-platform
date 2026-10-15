import { parseRawDiff } from "./diff-lists.ts";
import type { GitRunner } from "./runner.ts";

const GITLINK = "160000";
const STEP_TIMEOUT_MS = 60_000;

/**
 * MC2, one place for both stagers (a lane commit and a checkpoint capture). After an `add`, a nested repository below a
 * chosen or untracked folder sits in the index as a mode-160000 entry (git only warns "adding embedded git repository"):
 * it would be committed as a dangling submodule pointer, and once tracked the owner's own `git status` runs the nested
 * repository's clean filter. This lists the index entries that are gitlinks and are not in HEAD, takes them out of the
 * index with `rm --cached -f` (the worktree is never touched) and returns their paths. The index is the one the call's
 * `env` names (`GIT_INDEX_FILE`, a capture's temporary index) or the lane's own.
 */
export async function dropNewGitlinks(
  git: GitRunner,
  root: string,
  gitDir: string,
  env: Readonly<Record<string, string>> = {},
  encoding: "utf8" | "latin1" = "utf8",
): Promise<string[]> {
  const run = { gitDir, env, timeoutMs: STEP_TIMEOUT_MS } as const;
  const listed = await git.run(
    root,
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--ignore-submodules=dirty"],
    run,
  );
  const added = parseRawDiff(listed.stdout, encoding)
    .filter((entry) => entry.newMode === GITLINK && entry.oldMode !== GITLINK)
    .map((entry) => entry.path);
  if (added.length === 0) return [];
  const input = Buffer.from(added.map((path) => `${path}\0`).join(""), encoding);
  await git.run(root, ["rm", "--cached", "-f", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    ...run,
    input,
  });
  return added;
}
