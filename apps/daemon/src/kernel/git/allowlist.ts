import { HOME_SUBCOMMANDS } from "./allowlist-homes.ts";
import { LANE_SUBCOMMANDS } from "./allowlist-lanes.ts";
import { FILTER_SCAN_ARGS, ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "./exec.ts";

export type GitProfile = "local" | "remote";
/** An option spelled exactly, or `prefix` followed by a value `value` matches in full (MC18: no abbreviation, no cluster). */
export type OptionRule = string | { readonly prefix: string; readonly value: RegExp };
/** One call's positionals, split at `--`, and the options it gave (each once). */
export interface CallShape {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly options: readonly string[];
}
export interface SubcommandRule {
  readonly options: readonly OptionRule[];
  /** Options the call must give (M9R9: `commit --file=-`). */
  readonly required?: readonly string[];
  /** Positionals accepted when they do not start with `-` (after `--` neither). */
  readonly positional: boolean;
  /** Every positional starts with `./` (MC15). */
  readonly dotSlash?: true;
  /** The exact shape of the call (M9R9): how many positionals, on which side of `--`, and the form of each. Absent: M8's free reads. */
  readonly shape?: (call: CallShape) => boolean;
  /** Only with a temporary index in the call's environment: `read-tree` would rewrite the real one. */
  readonly temporaryIndex?: true;
  /** `worktree add`, `remote get-url`: the first positional names a nested rule. */
  readonly nested?: Readonly<Record<string, SubcommandRule>>;
  /** Runs only under the remote profile; every other subcommand runs only under the local one (M9R10). */
  readonly remote?: true;
}

export const OWN_OPTIONS = ["--no-ext-diff", "--no-textconv"] as const;
const NO_EXTERNAL_PROGRAMS = ["diff", "log", "show"];

/**
 * M8's table, moved unchanged (MC17, MC18). A blocklist was bypassed three times (git has abbreviations, clusters, `-m`
 * with a config value, `--decorate-refs --`...), so an option is accepted only when it is spelled exactly as listed:
 * no abbreviation, no cluster, no `--opt value` form. Positionals (revs, pathspecs) are accepted when they do not start
 * with `-`, and after `--` too. A caller that needs another option extends the table with its own injection review.
 */
const READ: Readonly<Record<string, SubcommandRule>> = {
  // Task 4 brief tests: repository root and branch name.
  "rev-parse": { options: ["--show-toplevel", "--abbrev-ref"], positional: true },
  // M8R46: status --porcelain=v2 -z --branch --ignore-submodules=dirty
  // MC3 I1: `--untracked-files=normal` overrides the owner's `status.showUntrackedFiles=no` for the lane dirty check.
  status: {
    options: ["--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty", "--untracked-files=normal"],
    positional: true,
  },
  // M8R46: diff --numstat -z --ignore-submodules=dirty (a nested repository's own filters, MC13) --no-ext-diff --no-textconv HEAD --
  diff: { options: ["--numstat", "-z", "--ignore-submodules=dirty", ...OWN_OPTIONS], positional: true },
  // No planned caller yet: only the runner's own options.
  log: { options: OWN_OPTIONS, positional: true },
  show: { options: OWN_OPTIONS, positional: true },
  // M8R47: cat-file blob <spec>
  "cat-file": { options: [], positional: true },
  // M8R24: ls-files -z --cached -- ; M8R27: ls-files -z --cached --others --exclude-standard
  "ls-files": { options: ["-z", "--cached", "--others", "--exclude-standard"], positional: true },
  // M8R24: check-ignore -z --stdin --no-index. It runs without --literal-pathspecs (exit 128 under it, MC15), so a path
  // given as an argument must start with `./`: ':(glob)x' would be pathspec magic. Names on stdin are the caller's
  // to prefix the same way (modules/files/visibility.ts).
  "check-ignore": { options: ["-z", "--stdin", "--no-index"], positional: true, dotSlash: true },
  // No planned caller (tests read stdin); a file argument would run a clean filter, so none is accepted.
  "hash-object": { options: ["--stdin"], positional: false },
};

/** A lane entry replaces the read entry of the same subcommand (it lists the read options too). */
export const SUBCOMMANDS: Readonly<Record<string, SubcommandRule>> = {
  ...READ,
  ...LANE_SUBCOMMANDS,
  ...HOME_SUBCOMMANDS,
};

/** The exact `config` reads, the only `config` calls there are: a bare `config` could write. */
const CONFIG_READS = [FILTER_SCAN_ARGS, PUSH_SCAN_ARGS, ORIGIN_URLS_ARGS] as const;

const exactly = (args: readonly string[], fixed: readonly string[]): boolean =>
  args.length === fixed.length && fixed.every((arg, at) => args[at] === arg);

const fullMatch = (pattern: RegExp, text: string): boolean =>
  new RegExp(`^(?:${pattern.source})$`).test(text);

const optionMatches = (rule: OptionRule, arg: string): boolean =>
  typeof rule === "string"
    ? rule === arg
    : arg.startsWith(rule.prefix) && fullMatch(rule.value, arg.slice(rule.prefix.length));

/** `--source=<oid>` and `--source=<other>` are one option given twice. */
const optionName = (arg: string): string =>
  arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

function restAllowed(
  rule: SubcommandRule,
  rest: readonly string[],
  env: Readonly<Record<string, string>>,
): boolean {
  if (rule.nested) {
    const [name, ...tail] = rest;
    const inner = name !== undefined && Object.hasOwn(rule.nested, name) ? rule.nested[name] : undefined;
    return inner !== undefined && restAllowed(inner, tail, env);
  }
  if (rule.temporaryIndex && env.GIT_INDEX_FILE === undefined) return false;
  const before: string[] = [];
  const after: string[] = [];
  const options: string[] = [];
  const names = new Set<string>();
  let afterDashes = false;
  for (const arg of rest) {
    if (!afterDashes && arg === "--") {
      afterDashes = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (afterDashes || !rule.options.some((option) => optionMatches(option, arg))) return false;
      if (names.has(optionName(arg))) return false;
      names.add(optionName(arg));
      options.push(arg);
    } else if (!rule.positional || (rule.dotSlash && !arg.startsWith("./"))) return false;
    else (afterDashes ? after : before).push(arg);
  }
  if (rule.required?.some((option) => !options.includes(option))) return false;
  return rule.shape === undefined || rule.shape({ before, after, options });
}

/** The runner's own arguments for an allowlisted call, or null (refused before git starts). */
export function prepare(
  args: readonly string[],
  profile: GitProfile,
  env: Readonly<Record<string, string>> = {},
): string[] | null {
  if (profile === "local" && CONFIG_READS.some((fixed) => exactly(args, fixed))) return [...args];
  const [subcommand, ...rest] = args;
  const rule =
    subcommand !== undefined && Object.hasOwn(SUBCOMMANDS, subcommand) ? SUBCOMMANDS[subcommand] : undefined;
  if (subcommand === undefined || !rule) return null;
  if ((rule.remote === true) !== (profile === "remote")) return null;
  if (!restAllowed(rule, rest, env)) return null;
  return NO_EXTERNAL_PROGRAMS.includes(subcommand)
    ? [subcommand, ...OWN_OPTIONS, ...rest]
    : [subcommand, ...rest];
}
