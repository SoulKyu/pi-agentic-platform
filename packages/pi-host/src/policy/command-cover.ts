import { resolve } from "node:path";
import { errorClass } from "../bounded.ts";
import { judgeGit } from "./command-cover-git.ts";
import {
  type Cover,
  type CoverContext,
  GLOB,
  type Judge,
  type ShellFacts,
  judged,
  judgeWith,
  tilde,
} from "./command-cover-judge.ts";
import { gitGuard } from "./git-config-guard.ts";
import { READ_ONLY_COMMANDS } from "./read-only-commands.ts";
import {
  argvOf,
  CommandTooComplex,
  CommandTooLong,
  readCommandsWithDoubt,
  type Segment,
} from "./shell-words.ts";
import { realTarget, within } from "./target-path.ts";

export type { Cover, CoverContext, ShellFacts } from "./command-cover-judge.ts";

/** For a caller that gave no shell facts: nothing is covered, so everything keeps asking (M7R15). */
export const UNKNOWN_SHELL: ShellFacts = {
  commandPrefix: "unknown",
  shellPath: undefined,
  startupFile: false,
  cdPath: false,
  gitEnv: false,
  rgConfig: false,
  path: undefined,
};

export const MAX_COVERED_SEGMENTS = 32;
export const MAX_JUDGED_PATHS = 64;
const MAX_FOLDERS = 8;
const MAX_PATH_ENTRIES = 64;
const NOT = (why: string): Cover => ({ covered: false, why });

interface Parsed {
  readonly argv: readonly string[];
  /** Files read through `<`. */
  readonly inputs: readonly string[];
}

/** Whether every simple command of `command` is read-only or starts with an allowed prefix. Never throws (M7R8). */
export async function coverCommand(command: string, ctx: CoverContext): Promise<Cover> {
  try {
    return await cover(command, ctx);
  } catch (error) {
    process.stderr.write(`pi-host: read-only check failed (${errorClass(error)})\n`);
    return NOT("check failed");
  }
}

async function cover(command: string, ctx: CoverContext): Promise<Cover> {
  const shell = await shellRefusal(ctx);
  if (shell !== null) return NOT(shell);
  let segments: Segment[];
  try {
    const reading = readCommandsWithDoubt(command);
    if (reading.unsure) return NOT("unsure reading");
    segments = reading.segments;
  } catch (error) {
    if (error instanceof CommandTooLong || error instanceof CommandTooComplex) return NOT("unreadable");
    throw error;
  }
  if (segments.length === 0 || segments.length > MAX_COVERED_SEGMENTS) return NOT("segment count");
  const parsed: Parsed[] = [];
  for (const segment of segments) {
    const one = parseSegment(segment);
    if (typeof one === "string") return NOT(one);
    parsed.push(one);
  }
  const bases = basesOf(parsed, ctx);
  if (typeof bases === "string") return NOT(bases);
  const judge: Judge = { ctx, bases, budget: { paths: MAX_JUDGED_PATHS }, git: gitGuard(ctx.home) };
  for (const segment of parsed) {
    for (const input of segment.inputs) {
      const why = await judged(input, "read", judge);
      if (why !== null) return NOT(why);
    }
    if (segment.argv[0] === "cd") continue;
    if (ctx.prefixes?.some((prefix) => startsWith(segment.argv, prefix))) continue;
    if (!ctx.readOnly) return NOT("not allowed");
    const why = await judgeSegment(segment.argv, judge);
    if (why !== null) return NOT(why);
  }
  return { covered: true };
}

const startsWith = (argv: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 && prefix.length <= argv.length && prefix.every((word, at) => argv[at] === word);

/** M7R5. */
async function shellRefusal(ctx: CoverContext): Promise<string | null> {
  const { shell } = ctx;
  if (shell.commandPrefix !== undefined && shell.commandPrefix.trim() !== "") return "shell command prefix";
  if (shell.shellPath !== undefined) return "custom shell";
  if (shell.startupFile) return "shell startup file";
  const entries = (shell.path ?? "").split(":");
  if (entries.length > MAX_PATH_ENTRIES) return "PATH too long";
  const cwd = await realTarget(resolve(ctx.cwd));
  for (const entry of entries) {
    if (!entry.startsWith("/")) return "PATH entry not absolute";
    const spelled = resolve(entry);
    if (within(cwd, spelled) || within(cwd, await realTarget(spelled)))
      return "PATH entry inside the session folder";
  }
  return null;
}

/** M7R1: what stands around the command word, and its redirections. */
function parseSegment(segment: Segment): Parsed | string {
  const plain: string[] = [];
  const inputs: string[] = [];
  for (let at = 0; at < segment.words.length; at++) {
    const word = segment.words[at] as string;
    if (!segment.operators.has(at)) {
      plain.push(word);
      continue;
    }
    const target = segment.words[at + 1];
    at++;
    const verdict = redirection(word, target);
    if (verdict === null) return "redirection";
    if (verdict === "input" && target !== undefined) inputs.push(target);
  }
  const argv = argvOf(segment);
  if (argv.length === 0 || argv.length !== plain.length || argv[0] !== plain[0])
    return "wrapper, assignment or keyword";
  for (const word of [...plain, ...inputs]) if (!literal(word)) return "expansion";
  return { argv, inputs };
}

const literal = (word: string): boolean =>
  !word.includes("$") &&
  !word.includes("`") &&
  !(word.includes("{") && (word.includes(",") || word.includes("..")));

const OUTPUT: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>"]);
function redirection(operator: string, target: string | undefined): "input" | "ok" | null {
  const bare = operator.replace(/^\d+/, "");
  if (bare === "<") return "input";
  if (bare === "<<" || bare === "<<-" || bare === "<<<") return "ok";
  if ((bare === ">&" || bare === "<&") && target !== undefined && /^(?:\d{1,2}|-)$/.test(target)) return "ok";
  if (OUTPUT.has(bare) && target === "/dev/null") return "ok";
  return null;
}

/** M7R4: the session folder, then every `cd` target resolved against every folder collected so far. */
function basesOf(parsed: readonly Parsed[], ctx: CoverContext): string[] | string {
  let bases = [resolve(ctx.cwd)];
  for (const { argv } of parsed) {
    if (argv[0] !== "cd") continue;
    if (ctx.shell.cdPath) return "CDPATH is set";
    const rest = argv.slice(1);
    if (rest.length > 1 || rest.some((word) => word.startsWith("-"))) return "cd option";
    const target = rest.length === 0 ? ctx.home : tilde(rest[0] as string, ctx.home);
    if (target === null || GLOB.test(target)) return "cd target";
    bases = [...new Set([...bases, ...bases.map((base) => resolve(base, target))])];
    if (bases.length > MAX_FOLDERS) return "too many folders";
  }
  return bases;
}

async function judgeSegment(argv: readonly string[], judge: Judge): Promise<string | null> {
  const [name, ...args] = argv as [string, ...string[]];
  if (name === "git") return judgeGit(args, judge);
  if (name === "rg" && judge.ctx.shell.rgConfig) return "ripgrep config";
  const rule = READ_ONLY_COMMANDS.get(name);
  return rule ? judgeWith(rule, args, judge, ["."]) : "not a read-only command";
}
