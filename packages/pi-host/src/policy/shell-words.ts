import { argvOf, nestedText, readsCommands, type Segment } from "./shell-argv.ts";

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

export { argvOf, type Segment } from "./shell-argv.ts";
interface Reading {
  readonly out: Segment[];
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

/** End of the redirection operator that starts at `i` (`>`, `>>`, `>|`, `>&`, `<`, `<<`, `<<-`, `<<<`, `<&`, `<>`, `&>`, `&>>`). */
function operatorEnd(text: string, i: number): number {
  const c = text[i];
  const n = text[i + 1];
  if (c === "&") return text[i + 2] === ">" ? i + 3 : i + 2;
  if (c === ">") return n === ">" || n === "|" || n === "&" ? i + 2 : i + 1;
  if (n === "<") return text[i + 2] === "<" || text[i + 2] === "-" ? i + 3 : i + 2;
  return n === "&" || n === ">" ? i + 2 : i + 1;
}

const isBlank = (c: string | undefined): boolean => c === " " || c === "\t";

interface HereDocument {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** Whether the command that receives the body runs it as commands (a shell, `ssh`); known once its segment ends. */
  reads: boolean | null;
}

/** Characters that end a word where a here-document delimiter is read. */
const DELIMITER_END = " \t;&|\n()<>";
/** Where a `#` starts a comment: at the start of the text or right after one of these. */
const COMMENT_AFTER = " \t\n;&|()<>";

/** The delimiter word at `from` with its quotes and backslashes resolved (`'END OF'`, `"EOF"`, `\EOF`) and the index after it. */
function readDelimiter(text: string, from: number): { delimiter: string; end: number } {
  let at = from;
  let delimiter = "";
  while (at < text.length && !DELIMITER_END.includes(text[at] as string)) {
    const c = text[at] as string;
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, at + 1);
      const stop = close === -1 ? text.length : close;
      delimiter += text.slice(at + 1, stop);
      at = stop + 1;
    } else if (c === "\\") {
      delimiter += text[at + 1] ?? "";
      at += 2;
    } else {
      delimiter += c;
      at++;
    }
  }
  return { delimiter, end: Math.min(at, text.length) };
}

function lex(text: string, depth: number, reading: Reading): void {
  if (depth > MAX_NESTING) throw new CommandTooComplex("nested too deep");
  let words: string[] = [];
  let operators = new Set<number>();
  let current = "";
  let inWord = false;
  const pending: HereDocument[] = [];
  const endWord = (): void => {
    if (inWord) words.push(current);
    current = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length === 0) return;
    const segment: Segment = { words, depth, operators };
    words = [];
    operators = new Set();
    if (reading.out.length >= MAX_SEGMENTS) throw new CommandTooComplex("too many commands");
    reading.out.push(segment);
    const argv = argvOf(segment);
    for (const doc of pending) doc.reads ??= readsCommands(argv);
    const inner = nestedText(argv);
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
  /** The redirection operator at `i` becomes a word of its own; a here-document also queues its delimiter. */
  const operator = (i: number): number => {
    const fd = inWord && /^\d+$/.test(current) && text[i] !== "&" ? current : "";
    if (fd === "") endWord();
    else {
      current = "";
      inWord = false;
    }
    const end = operatorEnd(text, i);
    const op = fd + text.slice(i, end);
    operators.add(words.length);
    words.push(op);
    if (!/^\d*<<-?$/.test(op)) return end;
    let at = end;
    while (isBlank(text[at])) at++;
    const read = readDelimiter(text, at);
    if (read.delimiter !== "") {
      words.push(read.delimiter);
      pending.push({ delimiter: read.delimiter, stripTabs: op.endsWith("-"), reads: null });
    }
    return read.end;
  };
  /** After a newline: each queued here-document body, up to its delimiter line, is read as a text of its own. */
  const hereDocuments = (from: number): number => {
    let i = from;
    for (const doc of pending.splice(0)) {
      const start = i;
      let lineStart = i;
      let body: string;
      for (;;) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
          body = text.slice(start, lineStart);
          i = newline === -1 ? text.length : newline + 1;
          break;
        }
        if (newline === -1) {
          body = text.slice(start);
          i = text.length;
          break;
        }
        lineStart = newline + 1;
      }
      // Only a body that a shell will run is read as commands; the text of a file written by `cat` is data.
      if (doc.reads) lex(body, depth + 1, reading);
    }
    return i;
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
    } else if (c === "$" && next === "'") {
      // ANSI-C quoting: a backslash pair never closes the quote. The text stays undecoded (a documented pass).
      let end = i + 2;
      while (end < text.length && text[end] !== "'") end += text[end] === "\\" ? 2 : 1;
      current += `$${text.slice(i + 2, Math.min(end, text.length))}`;
      inWord = true;
      i = end + 1;
    } else if (c === "$" && next === '"') i++;
    else if (
      c === "$" &&
      (text.startsWith("{IFS}", i + 1) ||
        (text.startsWith("IFS", i + 1) && !/[A-Za-z0-9_]/.test(text[i + 4] ?? "")))
    ) {
      endWord();
      i += next === "{" ? 6 : 4;
    } else if (c === "`" || (c === "$" && next === "(")) i = substitution(i);
    else if (isBlank(c)) {
      endWord();
      i++;
    } else if (c === "#" && !inWord && (i === 0 || COMMENT_AFTER.includes(text[i - 1] as string))) {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
    } else if (((c === ">" || c === "<") && next !== "(") || (c === "&" && next === ">")) i = operator(i);
    else if (c === "\n") {
      endCommand();
      i++;
      if (pending.length > 0) i = hereDocuments(i);
    } else if (";&|()".includes(c)) {
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
