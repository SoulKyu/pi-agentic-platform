import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { argvOf, readCommandsWithDoubt } from "./shell-words.ts";
import { within } from "./target-path.ts";

const NEVER_FIRST: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "ash",
  "mksh",
  "tcsh",
  "csh",
  "sudo",
  "doas",
  "su",
  "runuser",
  "env",
  "command",
  "builtin",
  "exec",
  "eval",
  "source",
  ".",
  "xargs",
  "nohup",
  "time",
  "nice",
  "ionice",
  "stdbuf",
  "timeout",
  "busybox",
  "setsid",
  "unshare",
  "watch",
  "chroot",
  "flock",
  "script",
  "sg",
]);
const FIRST = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SUB = /^[a-z][a-z0-9:._-]{0,63}$/;
const RUNNERS: ReadonlySet<string> = new Set(["run", "exec", "x", "dlx"]);

/** What judges the folder of `cd <folder> && <command>`: the session folder, and whether CDPATH is set. */
export interface SessionFolder {
  readonly cwd: string;
  readonly cdPath: boolean;
}

/** `cd <plain folder word> && <rest>`: the folder word has no quote, expansion or operator, so the first `&&` is the join. */
const CD_AND = /^cd[ \t]+([A-Za-z0-9._+@%/][A-Za-z0-9._+@%/-]*)[ \t]+&&[ \t]+([^\n]+)$/;

function insideFolder(word: string, folder: SessionFolder): boolean {
  try {
    const root = realpathSync(folder.cwd);
    const target = realpathSync(resolve(folder.cwd, word));
    return statSync(target).isDirectory() && within(root, target);
  } catch {
    return false;
  }
}

/**
 * M7R18: the prefix a bash card offers for "always", or null when only the exact command may be remembered. With the
 * session `folder`, `cd <folder inside it> && <one simple command>` offers the command's prefix (decision 117).
 */
export function proposePrefix(command: string, folder?: SessionFolder): readonly string[] | null {
  const dev = CD_AND.exec(command);
  if (dev === null) return simplePrefix(command);
  if (folder === undefined || folder.cdPath || !insideFolder(dev[1] as string, folder)) return null;
  return simplePrefix(dev[2] as string);
}

function simplePrefix(command: string): readonly string[] | null {
  let reading: ReturnType<typeof readCommandsWithDoubt>;
  try {
    reading = readCommandsWithDoubt(command);
  } catch {
    return null;
  }
  const segment = reading.segments[0];
  if (reading.unsure || reading.segments.length !== 1 || !segment) return null;
  if (segment.depth !== 0 || segment.operators.size > 0) return null;
  const argv = argvOf(segment);
  if (argv.length < 2 || argv.length !== segment.words.length || argv[0] !== segment.words[0]) return null;
  const [first, second, third] = argv as [string, string, string | undefined];
  if (!FIRST.test(first) || NEVER_FIRST.has(first) || !SUB.test(second)) return null;
  return RUNNERS.has(second) && third !== undefined && SUB.test(third)
    ? [first, second, third]
    : [first, second];
}
