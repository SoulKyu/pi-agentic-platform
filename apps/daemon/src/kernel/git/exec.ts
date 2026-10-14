import { dirname } from "node:path";

/**
 * Config switched off on every call (M8R20, MC14, MC16). Most entries close a way a repository's own config can run a
 * program that a real-git test demonstrates. Defence in depth, no test can fail for them: `core.pager` (git pages only
 * on a terminal), `credential.helper` and `protocol.allow` (transports are refused by `GIT_ALLOW_PROTOCOL`). The runner
 * only starts allowlisted subcommands with allowlisted options (runner.ts), so these entries are the second line. Not
 * covered: clean/smudge filter drivers on files git itself compares (a documented residual).
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
  // Defence in depth behind the runner's option allowlist: `-m` / `--diff-merges=on` would remerge (merge drivers) and
  // `--alternate-refs` would run this command.
  "log.diffMerges=separate",
  "core.alternateRefsCommand=",
  "diff.submodule=short",
  "safe.bareRepository=explicit",
] as const;

/**
 * `--literal-pathspecs` keeps every pathspec literal, but `check-ignore` exits 128 under it with `--stdin` and with
 * paths alike (MC15). Its callers send names as `./name`, which cannot parse as pathspec magic (`:(glob)x`).
 */
const WITHOUT_LITERAL_PATHSPECS = new Set(["check-ignore"]);

export function gitArgs(root: string, args: readonly string[]): string[] {
  return [
    "--no-optional-locks",
    ...(WITHOUT_LITERAL_PATHSPECS.has(args[0] ?? "") ? [] : ["--literal-pathspecs"]),
    ...SAFE_CONFIG.flatMap((pair) => ["-c", pair]),
    "-C",
    root,
    ...args,
  ];
}

const KEPT = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "XDG_CONFIG_HOME"] as const;

/** M8R21: an allowlist, and a ceiling at the root's parent so discovery never climbs above the root (RT-16). */
export function gitEnv(base: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KEPT) if (base[key] !== undefined) env[key] = base[key];
  return {
    ...env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    // Overrides every protocol.*.allow of a repository's config, on every git version (GIT_NO_LAZY_FETCH needs 2.44).
    GIT_ALLOW_PROTOCOL: "",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_CEILING_DIRECTORIES: dirname(root),
  };
}
