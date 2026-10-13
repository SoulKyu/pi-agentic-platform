import { homedir } from "node:os";
import { CALL_BUDGET, globMatch, PAIR_BUDGET, type StepBudget } from "./glob.ts";
import type { CallFacts, StageResult } from "./pipeline.ts";
import { clipUnits } from "./trail.ts";
import { argvOf, CommandTooComplex, CommandTooLong, readCommands, type Segment } from "./shell-words.ts";

export const DENYLIST_MODEL_REASON = "pap-policy blocked this command: it is on the blocked-command list.";
const TOO_LONG = "command too long for the policy check";
const TOO_COMPLEX = "command too complex for the policy check";
const MAX_NAMED_PATTERN = 100;
const DISK = /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|md|dm-|mapper\/)/;
// Slashes and stars are squeezed first, so no expression below has two quantifiers over the same character (linear on any word).
const squeeze = (arg: string) => arg.replace(/\/+/g, "/").replace(/\*+/g, "*");
const isDisk = (arg: string) => DISK.test(squeeze(arg));
// `--recursive` and its unambiguous abbreviations: `rm` has no other `--r…` option, the ownership tools have `--reference`.
const longRecursive = (arg: string, shortest: number) =>
  arg.length >= shortest && arg.length <= 11 && "--recursive".startsWith(arg);
const recursive = (arg: string) => longRecursive(arg, 3) || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg);
const recursiveOwnership = (arg: string) => longRecursive(arg, 5) || /^-[a-zA-Z]*R/.test(arg);
// `/`, `//`, `/.`, `/./`, `/*`, `/**`: the root.
const isRoot = (arg: string) => /^\/\.?\/?\*?$/.test(squeeze(arg));
// ... or the home directory: `~`, `~user`, `~/`, `~/*`, `$HOME`, `${HOME}/` once quotes are gone (the lexer removed them) ...
const HOME_VARIABLE = /^(?:~[\w.-]*|\$HOME|\$\{HOME(?:[-:=+?#%^,][^}]{0,32})?\})(?:\/\.?)?\*?$/;
// ... or the home written as the literal path the model saw in `pwd`, and each ancestor of it (`/home`, `/home/*`).
// Computed once at load, from `os.homedir()` and `$HOME` when they differ.
const trimmed = (path: string) => squeeze(path).replace(/\/$/, "");
const HOME_PATHS: ReadonlySet<string> = new Set(
  [homedir(), process.env["HOME"] ?? ""].flatMap((home) => {
    const parts = trimmed(home).split("/").filter(Boolean);
    return home.startsWith("/") ? parts.map((_, n) => `/${parts.slice(0, n + 1).join("/")}`) : [];
  }),
);
const rootLike = (arg: string) =>
  isRoot(arg) ||
  HOME_VARIABLE.test(squeeze(arg)) ||
  HOME_PATHS.has(squeeze(arg).replace(/(?:\/\.?)?\*?$/, ""));
const operands = (argv: readonly string[]) => argv.slice(1).filter((arg) => !arg.startsWith("-"));
const REDIRECT_TO_FILE = /^(?:\d*>[>|&]?|\d*<>|&>>?)$/;

type Check = { readonly id: string; matches(argv: readonly string[], segment: Segment): boolean };
export const BUILTIN_CHECKS: ReadonlyArray<Check> = [
  {
    id: "rm-root",
    matches: (a) => a[0] === "rm" && a.slice(1).some(recursive) && operands(a).some(rootLike),
  },
  {
    id: "chmod-root",
    matches: (a) =>
      ["chmod", "chown", "chgrp"].includes(a[0] ?? "") &&
      a.slice(1).some(recursiveOwnership) &&
      operands(a).some(isRoot),
  },
  { id: "mkfs", matches: (a) => /^(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|mkswap)$/.test(a[0] ?? "") },
  {
    id: "dd-device",
    matches: (a) => a[0] === "dd" && a.slice(1).some((x) => x.startsWith("of=") && isDisk(x.slice(3))),
  },
  {
    id: "wipe-device",
    matches: (a) =>
      ["shred", "wipefs", "blkdiscard"].includes(a[0] ?? "") &&
      operands(a).some((x) => squeeze(x).startsWith("/dev/")),
  },
  {
    id: "redirect-device",
    matches: (_a, segment) =>
      [...segment.operators].some(
        (at) => REDIRECT_TO_FILE.test(segment.words[at] as string) && isDisk(segment.words[at + 1] ?? ""),
      ),
  },
];
export const FORK_BOMB_ID = "fork-bomb";
const ROUGH_MAX_CHARS = 4 * 1024 * 1024;
const ROUGH_BUDGET = 4_000_000;
const ROUGH_TAIL_WORDS = 64;
const DANGEROUS_NAME =
  /^(?:rm|chmod|chown|chgrp|mkfs(?:\.[a-z0-9]+)?|mke2fs|mkswap|dd|shred|wipefs|blkdiscard)$/;
// `${…}` (bounded, so an unclosed run of openers is linear) and `$IFS` are read first; any other bracket is a blank.
const ROUGH_BRACKETS = /\$\{[^}]{0,64}\}|\$IFS\b|[`(){}]|&>>?|[<>]+[|&]?/g;
const roughBlank = (match: string): string => {
  if (match === "${IFS}" || match === "$IFS") return " ";
  if (match.startsWith("$")) return match;
  // A redirection to a file becomes a plain `>` before the cut at `|` and `&` parts it from its target; `<` stays apart.
  if (match.includes(">")) return " > ";
  return /^[<&]/.test(match) ? ` ${match} ` : " ";
};

/**
 * When the reader gives up, the built-in checks still run over a rough split of the raw text, as the reader reads it:
 * `\`+newline dropped, quotes and backslashes dropped, `$IFS` a blank, `${…}` kept whole, other brackets blanks,
 * redirection operators apart from their words, cut at newlines, `;`, `&`, `|`, then at blanks, command words reduced to
 * their basename. Every word and every word of a window costs a step; running out, or an input over the cap, throws
 * `CommandTooComplex`. It can only add blocks to a command that would be asked about.
 */
export function roughBuiltinHit(command: string, budget: StepBudget = { left: ROUGH_BUDGET }): string | null {
  const spend = (steps: number) => {
    budget.left -= steps;
    if (budget.left < 0) throw new CommandTooComplex("rough scan budget spent");
  };
  if (command.length > ROUGH_MAX_CHARS) throw new CommandTooComplex("rough scan: input too long");
  spend(command.length >> 3);
  const plain = command
    .replace(/\\\n/g, "")
    .replace(/['"\\]/g, "")
    .replace(ROUGH_BRACKETS, roughBlank);
  for (const piece of plain.split(/\n|;|&|\|/)) {
    const words = piece.split(/\s+/);
    for (const [at, word] of words.entries()) {
      spend(1);
      if (REDIRECT_TO_FILE.test(word) && isDisk(words[at + 1] ?? "")) return "redirect-device";
      const name = word.slice(word.lastIndexOf("/") + 1);
      if (!DANGEROUS_NAME.test(name)) continue;
      const argv = [name, ...words.slice(at + 1, at + ROUGH_TAIL_WORDS)];
      spend(argv.length);
      const operators = new Set(argv.flatMap((arg, n) => (REDIRECT_TO_FILE.test(arg) ? [n] : [])));
      const hit = BUILTIN_CHECKS.find((check) => check.matches(argv, { words: argv, depth: 0, operators }));
      if (hit) return hit.id;
    }
  }
  return null;
}

/**
 * A function whose body pipes itself into itself in the background (`:(){ :|:& };:`, `f(){ f|f& }`). Linear: one scan for
 * `(){`, then a bounded look around each hit (a regex with a leading identifier and a backreference is quadratic on a long
 * run of letters).
 */
export function isForkBomb(command: string): boolean {
  const selfPiping = (name: string, after: number): boolean =>
    command
      .slice(after, after + 256)
      .replace(/\s+/g, "")
      .startsWith(`${name}|${name}&`);
  for (const match of command.matchAll(/\(\s*\)\s*\{/g)) {
    const before = command.slice(Math.max(0, match.index - 64), match.index).trimEnd();
    const name = /(?:[A-Za-z_][A-Za-z0-9_]{0,62}|:)$/.exec(before)?.[0];
    if (name && selfPiping(name, match.index + match[0].length)) return true;
  }
  // `function f { f|f& }` has no parentheses.
  for (const match of command.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]{0,62})\s*\{/g))
    if (selfPiping(match[1] as string, match.index + match[0].length)) return true;
  return false;
}

/**
 * The same blank for the pattern and the command: Unicode space separators (NBSP, em space…) become a space, runs of
 * spaces one space (a command's words are joined by one), lone surrogates U+FFFD. A pattern the owner typed with a
 * lookalike blank would otherwise never match. The preset does not use this: bash does not split on those blanks.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// A pattern is spaced around redirection operators the way the lexer spaces a command: `*>/etc/*` -> `* > /etc/*`.
const OPERATORS = /\s*(&>>|&>|<<<|<<-|<<|<>|<&|<|>>|>\||>&|>)\s*/g;
const FD_OPERATORS = /(^| )(\d+) (>>|>\||>&|>|<<<|<<-|<<|<>|<&|<) /g;
const spaceOperators = (pattern: string): string =>
  pattern.replace(OPERATORS, " $1 ").replace(FD_OPERATORS, "$1$2$3 ").trim();
const plainBlanks = (text: string): string =>
  text
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(/\p{Zs}/gu, " ")
    .replace(/ {2,}/g, " ");

/** The owner's globs against both forms of every segment (M5R17); throws `CommandTooComplex` past a budget. */
export function matchOwnerPatterns(
  segments: readonly Segment[],
  patterns: readonly string[],
  ignoreCase: boolean,
  total: StepBudget,
): string | null {
  const fold = (text: string) => plainBlanks(ignoreCase ? text.toLowerCase() : text);
  const folded = patterns.map((pattern) => {
    const text = fold(spaceOperators(pattern));
    const wild = text.search(/[*?]/);
    return { pattern, text, wild, prefix: wild === -1 ? text : text.slice(0, wild) };
  });
  for (const segment of segments) {
    const forms = [...new Set([segment.words.join(" "), argvOf(segment).join(" ")])].map(fold);
    for (const { pattern, text, wild, prefix } of folded) {
      for (const form of forms) {
        // The literal prefix first: most pairs end here without a glob step.
        if (wild === -1 ? form !== text : !form.startsWith(prefix)) continue;
        const pair: StepBudget = { left: Math.min(PAIR_BUDGET, total.left) };
        const before = pair.left;
        try {
          if (globMatch(text, form, { ignoreCase: false, budget: pair })) return pattern;
        } finally {
          total.left -= before - Math.max(pair.left, 0);
        }
      }
    }
  }
  return null;
}

const block = (reason: string, modelReason = DENYLIST_MODEL_REASON): StageResult => ({
  outcome: "block",
  reason,
  modelReason,
});
// The reader's limits: the command was not judged, which the pipeline turns into a question or a block (Task 8c).
const unchecked = (reason: string): StageResult => ({ outcome: "unchecked", reason, modelReason: reason });

/** Stage 01 (M5R16 to M5R20, M5R117): reasons name a check or a pattern, never the command. */
export function denylistStage(call: CallFacts): StageResult {
  const command = (call.event.input as { command?: unknown } | null)?.command;
  // M5R117: a built-in shell, or any tool that is not Pi's built-in (MCP, extension) with a string `command`.
  const isCommand = (call.kind.category === "exec" && call.kind.builtin) || !call.kind.builtin;
  if (!isCommand || typeof command !== "string") return { outcome: "skip", reason: "not a command" };
  const powershell = call.kind.builtin && call.event.toolName === "powershell";
  let segments: Segment[];
  try {
    segments = readCommands(command);
  } catch (error) {
    if (!(error instanceof CommandTooLong || error instanceof CommandTooComplex)) throw error;
    // The built-in checks need no reader: padding must not turn a catastrophic command into a question.
    if (!powershell && call.rules.builtinDenylist) {
      try {
        const hit = isForkBomb(command) ? FORK_BOMB_ID : roughBuiltinHit(command);
        if (hit !== null) return block(`denied: ${hit}`);
      } catch (inner) {
        // An input too heavy even for the rough scan is not daily use: it blocks.
        if (!(inner instanceof CommandTooComplex)) throw inner;
        return block(TOO_COMPLEX, TOO_COMPLEX);
      }
    }
    return unchecked(error instanceof CommandTooLong ? TOO_LONG : TOO_COMPLEX);
  }
  if (!powershell && call.rules.builtinDenylist) {
    if (isForkBomb(command)) return block(`denied: ${FORK_BOMB_ID}`);
    for (const segment of segments) {
      const argv = argvOf(segment);
      const hit = BUILTIN_CHECKS.find((check) => check.matches(argv, segment));
      if (hit) return block(`denied: ${hit.id}`);
    }
  }
  try {
    const hit = matchOwnerPatterns(segments, call.rules.denylist, powershell, { left: CALL_BUDGET });
    if (hit !== null) return block(`denied: ${clipUnits(hit, MAX_NAMED_PATTERN)}`);
  } catch (error) {
    if (error instanceof CommandTooComplex) return unchecked(TOO_COMPLEX);
    throw error;
  }
  return { outcome: "pass", reason: `${segments.length} command${segments.length === 1 ? "" : "s"} checked` };
}
