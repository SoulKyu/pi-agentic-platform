/** From the words of one simple command to the command that runs: wrappers, redirections and keywords stripped (M5R20). */

export interface Segment {
  readonly words: readonly string[];
  /** 0 for the text as written; one more for each substitution, `-c` argument, here-document or `eval` read again. */
  readonly depth: number;
  /** Indexes of the words that are redirection operators (the word after each one is its target). */
  readonly operators: ReadonlySet<number>;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash", "mksh", "tcsh", "csh"]);
/** Programs whose `-c` option takes a command line, like a shell's, wherever it stands. */
const COMMAND_STRING_PROGRAMS = new Set(["su", "runuser", "script"]);
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "+o", "-O", "+O"]);
const SSH_OPTIONS_WITH_VALUE = new Set(
  "-p -i -l -o -F -J -L -R -D -b -c -E -e -I -m -O -Q -S -W -w".split(" "),
);
const COMMAND_OPTION = /^-[a-z]*c[a-z]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NO_VALUES: ReadonlySet<string> = new Set();
const values = (list: string): ReadonlySet<string> => new Set(list.split(" "));

interface Wrapper {
  readonly valued: ReadonlySet<string>;
  /** Words that stand between the options and the command (a duration, a lock file, a new root). */
  readonly positional?: number;
}
/** Wrappers that only run the next word: the options that take a value, and the positionals before the command. */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  [
    "sudo",
    {
      valued: values(
        "-u -g -C -h -p -r -t -U --user --group --close-from --host --prompt --role --type --other-user --chdir",
      ),
    },
  ],
  ["doas", { valued: values("-u -C") }],
  ["env", { valued: values("-u -C --unset --chdir") }],
  ["command", { valued: NO_VALUES }],
  ["exec", { valued: values("-a") }],
  ["nohup", { valued: NO_VALUES }],
  ["time", { valued: NO_VALUES }],
  ["nice", { valued: values("-n --adjustment") }],
  ["ionice", { valued: values("-c -n --class --classdata") }],
  ["stdbuf", { valued: values("-i -o -e") }],
  ["timeout", { valued: values("-s -k --signal --kill-after"), positional: 1 }],
  ["xargs", { valued: values("-a -d -E -I -L -n -P -s") }],
  ["busybox", { valued: NO_VALUES }],
  ["function", { valued: NO_VALUES, positional: 1 }],
  ["setsid", { valued: NO_VALUES }],
  ["unshare", { valued: NO_VALUES }],
  ["watch", { valued: values("-n -d") }],
  ["chroot", { valued: NO_VALUES, positional: 1 }],
  ["flock", { valued: values("-w -E"), positional: 1 }],
]);
/** Words that only start or join commands: `{`, `}`, `!` and the compound-command keywords. */
const SINGLE_WRAPPER_WORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "coproc",
]);

const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1);
const commandName = (word: string): string => baseName(word.replace(/^\\+/, ""));

/**
 * Whether `option` takes the next word as its value. getopt rule for a cluster of short options: the first letter that
 * takes a value takes the rest of the word (`-uroot`, `-k5s`), and the next word only when it is the last letter (`-Eu`).
 */
function takesNextWord(option: string, valued: ReadonlySet<string>): boolean {
  if (option.startsWith("--") || option.length < 2) return valued.has(option);
  for (let at = 1; at < option.length; at++)
    if (valued.has(`-${option[at]}`)) return at === option.length - 1;
  return false;
}

/**
 * Commands that only write their standard input out: a here-document they receive is data. Any other receiver (a shell
 * however reached: `sudo -s`, `su -`, `chroot /mnt`, `$SHELL`…) has its body read as commands.
 */
const DATA_RECEIVERS: ReadonlySet<string> = new Set(["cat", "tee"]);
export const receivesData = (argv: readonly string[]): boolean => DATA_RECEIVERS.has(argv[0] ?? "");

/** The words from the command word on, with the wrappers and redirections gone and the command word reduced to its basename. */
export function argvOf(segment: Pick<Segment, "words" | "operators">): readonly string[] {
  const words: string[] = [];
  for (let i = 0; i < segment.words.length; i++) {
    if (segment.operators.has(i)) i++;
    else words.push(segment.words[i] as string);
  }
  let i = 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (ASSIGNMENT.test(word) || SINGLE_WRAPPER_WORDS.has(word)) {
      i++;
      continue;
    }
    const wrapper = WRAPPERS.get(commandName(word));
    if (!wrapper) break;
    i++;
    while (i < words.length) {
      const option = words[i] as string;
      if (option === "--") {
        i++;
        break;
      }
      if (option === "-" || !option.startsWith("-")) break;
      i++;
      if (takesNextWord(option, wrapper.valued) && i < words.length) i++;
    }
    i = Math.min(words.length, i + (wrapper.positional ?? 0));
  }
  if (i >= words.length) return [];
  return [commandName(words[i] as string), ...words.slice(i + 1)];
}

/** The text of a `-c` argument, `eval` command or remote command line that a segment runs, if it is one. */
export function nestedText(argv: readonly string[]): string | null {
  const [name, ...rest] = argv;
  if (name === undefined) return null;
  if (name === "eval") return rest.length > 0 ? rest.join(" ") : null;
  if (name === "ssh") {
    let i = 0;
    while (i < rest.length && (rest[i] as string).startsWith("-"))
      i += SSH_OPTIONS_WITH_VALUE.has(rest[i] as string) ? 2 : 1;
    if (rest[i + 1] === "--") i++;
    return rest.length > i + 1 ? rest.slice(i + 1).join(" ") : null;
  }
  if (COMMAND_STRING_PROGRAMS.has(name)) {
    const at = rest.findIndex((word) => COMMAND_OPTION.test(word));
    return at === -1 ? null : (rest[at + 1] ?? null);
  }
  if (!SHELLS.has(name)) return null;
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i] as string;
    if (!option.startsWith("-") && !option.startsWith("+")) return null;
    if (COMMAND_OPTION.test(option)) {
      // The command is the first word after `-c` that is not an option (`bash -c -- 'cmd'`, `bash -c -x 'cmd'`).
      let k = i + 1;
      while (k < rest.length && /^[-+]/.test(rest[k] as string)) {
        const skipped = rest[k] as string;
        k++;
        if (skipped === "--") break;
        if (SHELL_OPTIONS_WITH_VALUE.has(skipped)) k++;
      }
      return rest[k] ?? null;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(option)) i++;
  }
  return null;
}
