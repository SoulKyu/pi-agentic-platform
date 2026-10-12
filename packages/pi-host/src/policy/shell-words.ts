/** Reads a shell command line the way bash splits it into simple commands (M5R18, M5R20). Best effort, see docs/agents/policy.md. */

export const MAX_CHECKED_COMMAND = 65_536;
const MAX_SEGMENTS = 1000;
const MAX_NESTING = 3;

export class CommandTooLong extends Error {
  constructor() {
    super("command too long for the policy check");
  }
}
export class CommandTooComplex extends Error {
  constructor(detail = "too many commands or too deep") {
    super(`command too complex for the policy check: ${detail}`);
  }
}

export interface Segment {
  readonly words: readonly string[];
  /** 0 for the text as written; one more for each substitution, `-c` argument or `eval` read again. */
  readonly depth: number;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "+o", "-O", "+O"]);
const COMMAND_OPTION = /^-[a-z]*c[a-z]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NO_VALUES: ReadonlySet<string> = new Set();
const values = (...options: string[]): ReadonlySet<string> => new Set(options);

/** Wrappers that only run the next word: the options that take a value, and whether a positional (a duration) precedes the command. */
const WRAPPERS: ReadonlyMap<string, { readonly valued: ReadonlySet<string>; readonly positional?: true }> =
  new Map([
    ["sudo", { valued: values("-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U") }],
    ["doas", { valued: values("-u", "-C") }],
    ["env", { valued: values("-u", "-C") }],
    ["command", { valued: NO_VALUES }],
    ["exec", { valued: values("-a") }],
    ["nohup", { valued: NO_VALUES }],
    ["time", { valued: NO_VALUES }],
    ["nice", { valued: values("-n") }],
    ["ionice", { valued: values("-c", "-n") }],
    ["stdbuf", { valued: values("-i", "-o", "-e") }],
    ["timeout", { valued: values("-s", "-k"), positional: true }],
    ["xargs", { valued: values("-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s") }],
    ["busybox", { valued: NO_VALUES }],
  ]);
const SINGLE_WRAPPER_WORDS = new Set(["{", "}", "!"]);

const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1);
const commandName = (word: string): string => baseName(word.replace(/^\\+/, ""));

/** The words from the command word on, with the wrappers gone and the command word reduced to its basename (M5R20). */
export function argvOf(words: readonly string[]): readonly string[] {
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
      if (wrapper.valued.has(option) && i < words.length) i++;
    }
    if (wrapper.positional && i < words.length) i++;
  }
  if (i >= words.length) return [];
  return [commandName(words[i] as string), ...words.slice(i + 1)];
}

interface Reading {
  readonly out: Segment[];
}

/** The text of a `-c` argument or `eval` command that a segment runs, if it is one. */
function nestedText(argv: readonly string[]): string | null {
  const [name, ...rest] = argv;
  if (name === "eval") return rest.length > 0 ? rest.join(" ") : null;
  if (name === undefined || !SHELLS.has(name)) return null;
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i] as string;
    if (!option.startsWith("-") && !option.startsWith("+")) return null;
    if (COMMAND_OPTION.test(option)) return rest[i + 1] ?? null;
    if (SHELL_OPTIONS_WITH_VALUE.has(option)) i++;
  }
  return null;
}

/** Index of the `)` closing a `$(` whose content starts at `from` (quotes skipped); the text length when it never closes. */
function closingParen(text: string, from: number): number {
  let level = 1;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") i += 2;
    else if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c) i += c === '"' && text[i] === "\\" ? 2 : 1;
      i++;
    } else {
      if (c === "(") level++;
      else if (c === ")" && --level === 0) return i;
      i++;
    }
  }
  return text.length;
}

/** Index of the backquote closing the one before `from`; the text length when it never closes. */
function closingBackquote(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] !== "`") i += text[i] === "\\" ? 2 : 1;
  return Math.min(i, text.length);
}

function lex(text: string, depth: number, reading: Reading): void {
  if (depth > MAX_NESTING) throw new CommandTooComplex("nested too deep");
  let words: string[] = [];
  let current = "";
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push(current);
    current = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length === 0) return;
    const segment: Segment = { words, depth };
    words = [];
    if (reading.out.length >= MAX_SEGMENTS) throw new CommandTooComplex("too many commands");
    reading.out.push(segment);
    const inner = nestedText(argvOf(segment.words));
    if (inner !== null) lex(inner, depth + 1, reading);
  };
  /** Reads the substitution opened at `i` (`$(` or a backquote); returns the index after it. */
  const substitution = (i: number): number => {
    const backquote = text[i] === "`";
    const start = i + (backquote ? 1 : 2);
    const end = backquote ? closingBackquote(text, start) : closingParen(text, start);
    lex(text.slice(start, end), depth + 1, reading);
    current += backquote ? "`…`" : "$(…)";
    inWord = true;
    return end + 1;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "\\") {
      if (next !== undefined && next !== "\n") {
        current += next;
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      current += text.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < text.length && text[i] !== '"') {
        const d = text[i] as string;
        const after = text[i + 1];
        if (d === "\\" && after !== undefined && '"\\$`'.includes(after)) {
          current += after;
          i += 2;
        } else if (d === "\\" && after === "\n") i += 2;
        else if (d === "`" || (d === "$" && after === "(")) i = substitution(i);
        else {
          current += d;
          i++;
        }
      }
      i++;
    } else if (c === "`" || (c === "$" && next === "(")) i = substitution(i);
    else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if ((c === ">" || c === "<") && next !== "(") {
      // A redirection operator is a word of its own, whatever it touches: `echo>/dev/sda`, `rm -rf />/dev/null`.
      const fd = inWord && /^\d+$/.test(current) ? current : "";
      if (fd === "") endWord();
      else {
        current = "";
        inWord = false;
      }
      let end = i + 1;
      if (text[end] === c) end++;
      else if (c === "<" && text[end] === ">") end++;
      if ((c === ">" || text[end - 1] === ">") && (text[end] === "|" || text[end] === "&")) end++;
      words.push(fd + text.slice(i, end));
      i = end;
    } else if (";&|\n()".includes(c)) {
      endCommand();
      i++;
    } else {
      current += c;
      inWord = true;
      i++;
    }
  }
  endCommand();
}

/** Every simple command of `command`, nested ones included (M5R18). Throws `CommandTooLong` / `CommandTooComplex`. */
export function readCommands(command: string): Segment[] {
  if (command.length > MAX_CHECKED_COMMAND) throw new CommandTooLong();
  const reading: Reading = { out: [] };
  lex(command, 0, reading);
  return reading.out;
}
