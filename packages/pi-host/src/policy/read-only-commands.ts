/**
 * The read-only command allowlist (decision 75 Q6, ADR 0024): shell commands that only read, list or print. A rule says
 * how the command's operands are judged and names every option that makes it write a file, run another program or read
 * a list of files from a file, in each spelling GNU getopt accepts. A command that is not here is not read-only (M7R7).
 */

/** How a path is judged: as the built-in tool of the same reach would be (`checkReadTarget`, M5R29). */
export type Reach = "read" | "grep" | "find" | "ls";

export interface Refusals {
  /** Short option letters refused anywhere in a cluster: `-o`, `-uo`, `-ofile`. */
  readonly short?: string;
  /**
   * Short letters that take a value: the rest of the cluster is that value, not more flags (`date -Iseconds`,
   * `sort -T/opt/tmp`), as getopt and clap read it. Only for tools verified to parse that way (date, sort, file): tree takes
   * the value from the next word and reads the rest of the cluster as flags, so it must not set this (M7 ruling MC15).
   * A refused letter before the first valued one still refuses.
   */
  readonly valued?: string;
  /** Long options refused in every abbreviation of three characters or more, with or without `=value`. */
  readonly long?: readonly string[];
  /** Single-dash words refused exactly (find's actions). */
  readonly exact?: readonly string[];
}

export interface CommandRule {
  /** How each operand is judged; `null`: operands are text, not paths (`echo`, `date`). */
  readonly operands: Reach | null;
  /** The session folder is judged too: always (M7R3), or only when no operand names a path (`ls`, `find`). */
  readonly root?: "always" | "bare";
  readonly refuse?: Refusals;
  /** More operands than this and the command writes (`uniq IN OUT`). */
  readonly maxOperands?: number;
  /** find: operands are the words before the first expression word; the rest is an expression, not paths. */
  readonly expression?: true;
  /** An option that makes a name lister walk a tree (`ls -R`): its operands are then judged like `find`'s. */
  readonly recursive?: { readonly short: string; readonly long: readonly string[] };
  /** Only these option words are allowed, in exactly this spelling: every other one refuses (`sed`: its other options write or run). */
  readonly only?: readonly string[];
  /** At least one of these option words must be present, before any `--` (`sed -n`: without it the script prints twice). */
  readonly needs?: readonly string[];
  /** The first operand is a script that must match this pattern, and is not a path (`sed`). */
  readonly script?: RegExp;
  /** The first operand is a pattern, text and not a path; the others are paths (`fd`). */
  readonly pattern?: true;
}

const FILES0 = "--files0-from";
/** sed as a line printer: `Np`, `N,Mp`, `N,$p`, `$p`. No blank, `;`, second command or write/read/execute command can match. */
const SED_PRINT = /^(?:\$|\d{1,9}(?:,(?:\d{1,9}|\$))?)p$/;
/**
 * fd runs programs with `-x`/`--exec`, `-X`/`--exec-batch` and `-l`/`--list-details` (an alias of `--exec-batch ls -l`), changes its folder with `--base-directory`, names paths by
 * option with `--search-path` and reads a file with `--ignore-file` (its value is a separate word that no rule judges).
 */
const FD: CommandRule = {
  operands: "find",
  root: "bare",
  pattern: true,
  refuse: {
    short: "xXl",
    long: ["--exec", "--exec-batch", "--list-details", "--base-directory", "--search-path", "--ignore-file"],
  },
};
const reads = (refuse?: Refusals, more: Partial<CommandRule> = {}): CommandRule => ({
  operands: "read",
  ...(refuse ? { refuse } : {}),
  ...more,
});
const TEXT: CommandRule = { operands: null };
const SEARCH: CommandRule = { operands: "grep", root: "always" };
const FIND_ACTIONS = [
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
  "-files0-from",
];
const CONTENT = [
  "cat",
  "head",
  "tail",
  "nl",
  "stat",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "b2sum",
  "cksum",
  "strings",
  "od",
  "cmp",
  "tac",
  "rev",
  "cut",
  "paste",
  "comm",
  "join",
  "fold",
  "jq",
];
const PRINTS = [
  "tr",
  "basename",
  "dirname",
  "echo",
  "printf",
  "true",
  "false",
  "pwd",
  "whoami",
  "id",
  "uname",
  "nproc",
  "uptime",
  "free",
  "df",
  "ps",
  "which",
];

export const READ_ONLY_COMMANDS: ReadonlyMap<string, CommandRule> = new Map<string, CommandRule>([
  ...CONTENT.map((name): [string, CommandRule] => [name, reads()]),
  ...PRINTS.map((name): [string, CommandRule] => [name, TEXT]),
  ["wc", reads({ long: [FILES0] })],
  [
    "file", // `-f` reads a list of files, `-m` a magic file whose rules can print file content, `-C` writes one (M7 ruling MC15).
    reads({ short: "Cfm", valued: "eFP", long: ["--compile", "--files-from", "--magic-file"] }),
  ],
  ["sort", reads({ short: "o", valued: "ktTS", long: ["--output", "--compress-program", FILES0] })],
  ["uniq", reads(undefined, { maxOperands: 1 })],
  ["diff", { operands: "grep" }],
  // `-f` / `--file` read a file and echo its unparsable lines on stderr; the value of a separate word is judged nowhere
  // for a rule without operands, so they ask in every form (M7 ruling MC14).
  [
    "date",
    { operands: null, refuse: { short: "sfr", valued: "dI", long: ["--set", "--file", "--reference"] } },
  ],
  ["realpath", { operands: "ls" }],
  ["readlink", { operands: "ls" }],
  ["ls", { operands: "ls", root: "bare", recursive: { short: "R", long: ["--recursive"] } }],
  ["eza", { operands: "ls", root: "bare", recursive: { short: "RT", long: ["--recursive", "--tree"] } }],
  ["fd", FD],
  ["fdfind", FD],
  [
    "sed",
    {
      operands: "read",
      only: ["-n", "--quiet", "--silent"],
      needs: ["-n", "--quiet", "--silent"],
      script: SED_PRINT,
    },
  ],
  ["tree", { operands: "find", root: "always", refuse: { short: "oR", long: ["--fromfile"] } }],
  ["du", { operands: "find", root: "always", refuse: { long: [FILES0] } }],
  ["find", { operands: "find", root: "bare", expression: true, refuse: { exact: FIND_ACTIONS } }],
  ["grep", SEARCH],
  ["egrep", SEARCH],
  ["fgrep", SEARCH],
  ["rg", { ...SEARCH, refuse: { long: ["--pre", "--hostname-bin"] } }],
]);

export interface GitRule {
  /** How operands (revisions and paths) are judged; default `read`. */
  readonly operands?: Reach;
  readonly refuse?: Refusals;
  /** Only these options: any other one refuses (their other options write). */
  readonly only?: readonly string[];
  /** Operands are allowed only next to one of these options (`git branch --list <pattern>`); `[]`: never. */
  readonly operandsWith?: readonly string[];
  /** The exact operands this subcommand takes (`git stash list`). */
  readonly exactly?: readonly string[];
}
const DIFFS: Refusals = { long: ["--output", "--ext-diff", "--textconv"] };
const PLAIN_GIT = [
  "status",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "describe",
  "shortlog",
  "merge-base",
  "name-rev",
  "count-objects",
  "check-ignore",
  "show-ref",
];

/** git subcommands that only read the repository (M7R6). Every one also judges the folder git walks (M7R3). */
export const GIT_READ_ONLY: ReadonlyMap<string, GitRule> = new Map<string, GitRule>([
  ...PLAIN_GIT.map((name): [string, GitRule] => [name, {}]),
  ["diff", { refuse: DIFFS }],
  ["log", { refuse: DIFFS }],
  ["show", { refuse: DIFFS }],
  ["blame", { refuse: { long: ["--textconv"] } }],
  ["grep", { operands: "grep", refuse: { short: "O", long: ["--open-files-in-pager", "--textconv"] } }],
  ["cat-file", { refuse: { long: ["--textconv", "--filters"] } }],
  [
    "branch",
    {
      only: [
        "-a",
        "--all",
        "-r",
        "--remotes",
        "-v",
        "-vv",
        "--verbose",
        "--show-current",
        "-l",
        "--list",
        "--no-color",
        "--no-column",
      ],
      operandsWith: ["-l", "--list"],
    },
  ],
  ["remote", { only: ["-v", "--verbose"], operandsWith: [] }],
  ["stash", { exactly: ["list"], refuse: DIFFS }],
  ["worktree", { exactly: ["list"] }],
]);

/** The only git options allowed before the subcommand; `-C <dir>` is handled apart (its folder is judged). */
export const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks"]);
