import { isAbsolute, resolve } from "node:path";
import { type Judge, judged, judgeWith, tilde } from "./command-cover-judge.ts";
import { repoConfigRefusal } from "./git-config-guard.ts";
import { kernelResolve } from "./kernel-path.ts";
import { GIT_GLOBAL_FLAGS, GIT_READ_ONLY } from "./read-only-commands.ts";
import { realTarget } from "./target-path.ts";

function split(words: readonly string[]): { options: string[]; operands: string[] } {
  const options: string[] = [];
  const operands: string[] = [];
  let ended = false;
  for (const word of words) {
    if (!ended && word === "--") ended = true;
    else if (!ended && word.length > 1 && word.startsWith("-")) options.push(word);
    else operands.push(word);
  }
  return { options, operands };
}

/** Each folder git may run in for `folder` (a `-C` path) from each base: as spelled, and as the kernel walks it. */
async function gitFolders(folder: string, judge: Judge): Promise<string[]> {
  const folders = new Set<string>();
  for (const base of judge.bases) {
    folders.add(resolve(base, folder));
    folders.add(await kernelResolve(base, folder));
  }
  return [...folders];
}

/** git's own words: global options, the subcommand's rule, the folder it walks, its repository's config, operands. */
export async function judgeGit(args: readonly string[], judge: Judge): Promise<string | null> {
  if (judge.ctx.shell.gitEnv) return "git environment";
  if (judge.ctx.tainted) return "git in a session that read external content";
  let at = 0;
  // `-C a -C b` is `cd a`, then `cd b`; an absolute one starts again (git's own rule).
  let folder = ".";
  while (at < args.length && (args[at] as string).startsWith("-")) {
    const flag = args[at] as string;
    if (flag === "-C" && at + 1 < args.length) {
      const next = tilde(args[at + 1] as string, judge.ctx.home);
      if (next === null) return "home folder of another user";
      folder = isAbsolute(next) || folder === "." ? next : `${folder}/${next}`;
      at += 2;
      continue;
    }
    if (!GIT_GLOBAL_FLAGS.has(flag)) return "git option";
    at++;
  }
  const sub = args[at];
  const rule = sub === undefined ? undefined : GIT_READ_ONLY.get(sub);
  if (!rule) return "not a read-only git command";
  const rest = args.slice(at + 1);
  const { options, operands } = split(rest);
  if (rule.only && options.some((option) => !rule.only?.includes(option))) return "git listing only";
  if (
    rule.operandsWith &&
    operands.length > 0 &&
    !options.some((option) => rule.operandsWith?.includes(option))
  )
    return "git listing only";
  if (
    rule.exactly &&
    (operands.length !== rule.exactly.length || operands.some((word, i) => word !== rule.exactly?.[i]))
  )
    return "git listing only";
  // M7R3: git walks the work tree it runs in, judged like find's root.
  const walked = await judged(folder, "find", judge);
  if (walked !== null) return walked;
  const folders = await gitFolders(folder, judge);
  // Owner m3: the repository's own config must run nothing. MC17: a repository must be found, so a folder outside every
  // repository asks. A missing or empty folder inside one is judged by the enclosing repository: a bare layout written
  // there in the same message is not seen here, and `safe.bareRepository=explicit` (MC18) keeps git from reading it.
  for (const start of folders) {
    const why = await repoConfigRefusal(await realTarget(start), judge.git, true);
    if (why !== null) return why;
  }
  // Operands are relative to the folder git runs in.
  return judgeWith(
    { operands: rule.operands ?? "read", ...(rule.refuse ? { refuse: rule.refuse } : {}) },
    rest,
    { ...judge, bases: folders },
    [],
  );
}
