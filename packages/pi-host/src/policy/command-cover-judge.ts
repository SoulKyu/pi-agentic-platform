import type { GitGuard } from "./git-config-guard.ts";
import type { CommandRule, Reach, Refusals } from "./read-only-commands.ts";
import { checkReadTarget } from "./read-target.ts";

/** What the shell that runs the command adds to it (M7R5). */
export interface ShellFacts {
  readonly commandPrefix: string | undefined;
  readonly shellPath: string | undefined;
  /** `BASH_ENV` or `ENV` is set: a non-interactive shell runs that file first. */
  readonly startupFile: boolean;
  /** `CDPATH` is set: a relative `cd` may land elsewhere. */
  readonly cdPath: boolean;
  /**
   * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY` or `GIT_INDEX_FILE` is set in the session
   * environment: git does not find or read its repository as the config check assumes (owner m3). The same names set in
   * the command itself are assignments, which the engine never covers.
   */
  readonly gitEnv: boolean;
  /** `RIPGREP_CONFIG_PATH` is set in the session environment: an rg config can carry `--pre` (M7 MC16). */
  readonly rgConfig: boolean;
  readonly path: string | undefined;
}
export interface CoverContext {
  readonly cwd: string;
  readonly home: string;
  readonly papHome: string;
  readonly agentDir: string;
  /** The session's own id, for its attachments (`checkReadTarget`). */
  readonly sessionId?: string | undefined;
  readonly shell: ShellFacts;
  /** The session read external content: git is never covered, because injected text may plant a config (MC17). */
  readonly tainted: boolean;
  /** Read-only commands cover segments (decision 75 Q6; the Settings switch). */
  readonly readOnly: boolean;
  /** Command prefixes the owner always allows (Task 2a): a segment whose words start with one is covered. */
  readonly prefixes?: readonly (readonly string[])[];
}
export type Cover = { readonly covered: true } | { readonly covered: false; readonly why: string };

/** The state of one command line's judgment: its folders and what it may still spend (M7R9). */
export interface Judge {
  readonly ctx: CoverContext;
  /** Every folder a relative path may be read from (M7R4). */
  readonly bases: readonly string[];
  readonly budget: { paths: number };
  readonly git: GitGuard;
}

const MAX_CLUSTER_SPLITS = 6;
export const GLOB = /[*?[]/;
const FIND_PREFIX_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-P"]);

export const tilde = (word: string, home: string): string | null =>
  !word.startsWith("~")
    ? word
    : word === "~"
      ? home
      : word.startsWith("~/")
        ? `${home}${word.slice(1)}`
        : null;
const staticFolder = (prefix: string): string => {
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "." : prefix.slice(0, slash + 1);
};

/** M7R2: one word as a path, from every folder the command may run in. */
export async function judged(word: string, reach: Reach, judge: Judge): Promise<string | null> {
  const expanded = tilde(word, judge.ctx.home);
  if (expanded === null) return "home folder of another user";
  const glob = expanded.search(GLOB);
  const path = glob === -1 ? expanded : staticFolder(expanded.slice(0, glob));
  const tool = glob === -1 ? reach : reach === "ls" || reach === "find" ? "find" : "grep";
  for (const cwd of judge.bases) {
    if (--judge.budget.paths < 0) return "too many paths";
    const review = await checkReadTarget(
      tool,
      { path },
      {
        cwd,
        papHome: judge.ctx.papHome,
        agentDir: judge.ctx.agentDir,
        sessionId: judge.ctx.sessionId,
      },
    );
    if (review) return review.why;
  }
  return null;
}

export function refused(word: string, refuse: Refusals | undefined): boolean {
  if (!refuse) return false;
  if (refuse.exact?.includes(word)) return true;
  if (word.startsWith("--")) {
    const name = word.split("=", 1)[0] as string;
    return name.length >= 3 && (refuse.long ?? []).some((option) => option.startsWith(name));
  }
  for (const letter of word.slice(1)) {
    if (refuse.short?.includes(letter)) return true;
    if (refuse.valued?.includes(letter)) return false;
  }
  return false;
}

/** The values an option word may carry (M7R2). */
function optionValues(word: string): string[] {
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    return equals === -1 ? [] : [word.slice(equals + 1)];
  }
  const values = new Set<string>();
  for (let at = 2; at < word.length && at <= 1 + MAX_CLUSTER_SPLITS; at++) values.add(word.slice(at));
  for (const mark of ["/", "~"]) {
    const at = word.indexOf(mark);
    if (at > 1) values.add(word.slice(at));
  }
  return [...values];
}

/** One command's words after its name, judged by its rule; `roots` are judged too when the rule says so (M7R3). */
export async function judgeWith(
  rule: CommandRule,
  args: readonly string[],
  judge: Judge,
  roots: readonly string[],
): Promise<string | null> {
  let operands = 0;
  let options = true;
  let expression = false;
  const recursive = rule.recursive && { short: rule.recursive.short, long: [rule.recursive.long] };
  const walks = recursive !== undefined && args.some((word) => refused(word, recursive));
  const reach: Reach | null = walks ? "find" : rule.operands;
  for (const word of args) {
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && word.length > 1 && word.startsWith("-")) {
      if (refused(word, rule.refuse)) return "refused option";
      for (const value of optionValues(word)) {
        const why = await judged(value, "read", judge);
        if (why !== null) return why;
      }
      // find's `-H`, `-L`, `-P` come before its start paths; any other option word starts the expression.
      if (rule.expression && !FIND_PREFIX_OPTIONS.has(word)) expression = true;
      continue;
    }
    if (rule.expression && (word === "(" || word === "!" || word === ")")) expression = true;
    if (expression || word === "-") continue;
    operands++;
    if (rule.maxOperands !== undefined && operands > rule.maxOperands) return "too many operands";
    if (reach !== null) {
      const why = await judged(word, reach, judge);
      if (why !== null) return why;
    }
  }
  if (rule.root === "always" || (rule.root === "bare" && operands === 0))
    for (const root of roots) {
      const why = await judged(root, reach ?? "read", judge);
      if (why !== null) return why;
    }
  return null;
}
