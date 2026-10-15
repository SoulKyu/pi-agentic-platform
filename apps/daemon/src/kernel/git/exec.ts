import { dirname } from "node:path";
import { NETWORK_ENV } from "../child-env.ts";
import type { GitProfile } from "./allowlist.ts";

/**
 * Config switched off on every call (M8R20, MC14, MC16). Most entries close a way a repository's own config can run a
 * program that a real-git test demonstrates. Defence in depth, no test can fail for them: `core.pager` (git pages only
 * on a terminal), `credential.helper` and `protocol.allow` (transports are refused by `GIT_ALLOW_PROTOCOL`). The runner
 * only starts allowlisted subcommands with allowlisted options (runner.ts), so these entries are the second line. Not
 * covered here: clean/smudge/process filter drivers on files git compares; `guardFilters` (filters.ts) empties them for
 * `status` and `diff` (MC13).
 */
const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "diff.external=",
  "protocol.allow=never",
  "credential.helper=",
  "log.showSignature=false",
  // A blank program cannot be run; they close %G?, --show-signature and format.pretty, which log.showSignature does not.
  "gpg.program=",
  "gpg.x509.program=",
  "gpg.ssh.program=",
  "gpg.ssh.defaultKeyCommand=",
  // Defence in depth behind the runner's option allowlist: `-m` / `--diff-merges=on` would remerge (merge drivers) and
  // `--alternate-refs` would run this command.
  "log.diffMerges=separate",
  "core.alternateRefsCommand=",
  "diff.submodule=short",
  "safe.bareRepository=explicit",
  // M9 (M9-RT-11): `commit` starts `git maintenance run --auto --detach`, which leaves the runner's group, its cap and
  // its kill (setsid); `submodule.recurse` would carry a checkout or a push into submodules.
  "maintenance.auto=false",
  "gc.auto=0",
  "submodule.recurse=false",
] as const;

/**
 * `--literal-pathspecs` keeps every pathspec literal, but `check-ignore` exits 128 under it with `--stdin` and with
 * paths alike (MC15). Its callers send names as `./name`, which cannot parse as pathspec magic (`:(glob)x`).
 */
const WITHOUT_LITERAL_PATHSPECS = new Set(["check-ignore"]);

/** Asks for every `filter.*` entry with its scope: `scope NUL key LF value NUL` repeated (git 2.26+). */
export const FILTER_SCAN_ARGS = ["config", "--null", "--show-scope", "--get-regexp", "^filter\\."] as const;

/** M9R10: a push needs the owner's credential helpers and a transport; it never recurses into submodules or adds tags. */
const REMOTE_DROPS: ReadonlySet<string> = new Set(["protocol.allow=never", "credential.helper="]);
/** `push.pushOption=` empties the list: a repository's own values would reach the forge (a GitLab merge request, skipped CI; MC4 I1). */
const REMOTE_ONLY = ["push.recurseSubmodules=no", "push.followTags=false", "push.pushOption="] as const;

/** Keys of a repository's own config that would run a program, or send a push elsewhere (M9R14). */
export const PUSH_SCAN_ARGS = [
  "config",
  "--null",
  "--show-scope",
  "--get-regexp",
  "^(core\\.(sshcommand|askpass|gitproxy)|credential\\..*helper|url\\..*\\.(insteadof|pushinsteadof)|http\\..*|remote\\..*\\.(vcs|proxy|receivepack|uploadpack|mirror))$",
] as const;
/** Every origin URL as configured, before any `insteadOf`: the forge identity, which must be single (M9R14). */
export const ORIGIN_URLS_ARGS = ["config", "--get-all", "remote.origin.url"] as const;

/**
 * Subcommands that write the worktree or the index from it run with `--work-tree=<root>` (M9-RT-11 d): a lane's
 * `config.worktree` with `core.worktree=<elsewhere>` would otherwise point `clean` and `restore` at another folder
 * (`-c core.worktree=` does not override it; `--work-tree` does, scratch-verified on git 2.53).
 */
export const WORK_TREE_PINNED = new Set(["add", "commit", "restore", "clean", "reset", "rm"]);

/**
 * MC1 I4: a lane's `.git` file says where its git dir is, and a write under it can say the owner's. A lane call names
 * its git dir itself, from pap's own record (`<common>/worktrees/<name>`), and git is told with `--git-dir` next to
 * `--work-tree`. Only the shape is checked here: an absolute, normalised path whose last two segments are
 * `worktrees/<name>`.
 */
export function isLaneGitDir(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0")) return false;
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return segments.length >= 3 && segments[segments.length - 2] === "worktrees";
}

export function gitArgs(
  root: string,
  args: readonly string[],
  gitDir?: string,
  profile: GitProfile = "local",
): string[] {
  const config =
    profile === "remote"
      ? [...SAFE_CONFIG.filter((pair) => !REMOTE_DROPS.has(pair)), ...REMOTE_ONLY]
      : SAFE_CONFIG;
  return [
    "--no-optional-locks",
    ...(WITHOUT_LITERAL_PATHSPECS.has(args[0] ?? "") ? [] : ["--literal-pathspecs"]),
    ...config.flatMap((pair) => ["-c", pair]),
    "-C",
    root,
    ...(gitDir === undefined ? [] : [`--git-dir=${gitDir}`]),
    // MC3 I2: a call that names its git dir also names its work tree, whatever the subcommand: a lane's `config.worktree`
    // with `core.worktree=<elsewhere>` must not redirect even a read.
    ...(gitDir !== undefined || WORK_TREE_PINNED.has(args[0] ?? "") ? [`--work-tree=${root}`] : []),
    ...args,
  ];
}

export const KEPT = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "XDG_CONFIG_HOME"] as const;
/** What a push needs from the daemon's environment: the shared proxies and CA bundles, and the owner's SSH agent. */
export const KEPT_REMOTE: readonly string[] = [...NETWORK_ENV, "SSH_AUTH_SOCK"];

/** M8R21: an allowlist, and a ceiling at the root's parent so discovery never climbs above the root (RT-16). */
export function gitEnv(
  base: NodeJS.ProcessEnv,
  root: string,
  profile: GitProfile = "local",
  remoteProtocols = "https:ssh",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KEPT) if (base[key] !== undefined) env[key] = base[key];
  if (profile === "remote") for (const key of KEPT_REMOTE) if (base[key] !== undefined) env[key] = base[key];
  // A relative entry (`.`, `node_modules/.bin`) would find a repository's own `git-lfs` or helper program (MC13).
  if (env.PATH !== undefined)
    env.PATH = env.PATH.split(":")
      .filter((entry) => entry.startsWith("/"))
      .join(":");
  return {
    ...env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    // Overrides every protocol.*.allow of a repository's config, on every git version (GIT_NO_LAZY_FETCH needs 2.44).
    // Local calls reach no transport; a push reaches only https and ssh (M9R10), whatever protocol.* says.
    GIT_ALLOW_PROTOCOL: profile === "remote" ? remoteProtocols : "",
    GIT_PAGER: "cat",
    PAGER: "cat",
    // A call that would open an editor gets one that does nothing (M9-RT-11).
    GIT_EDITOR: ":",
    GIT_SEQUENCE_EDITOR: ":",
    GIT_CEILING_DIRECTORIES: dirname(root),
  };
}
