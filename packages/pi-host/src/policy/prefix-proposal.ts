import { argvOf, readCommandsWithDoubt } from "./shell-words.ts";

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

/** M7R18: the prefix a bash card offers for "always", or null when only the exact command may be remembered. */
export function proposePrefix(command: string): readonly string[] | null {
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
