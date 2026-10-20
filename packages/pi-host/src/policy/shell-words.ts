import { argvOf, nestedText, receivesData, type Segment } from "./shell-argv.ts";
import { findBody, PendingDocuments, readDelimiter } from "./shell-heredoc.ts";

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
  /** Set once any text was read in a way bash may read differently (quotes inside a double-quoted `${…}`). */
  unsure: boolean;
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
/** What closes a `${…}` or a `$[…]` opened by `$` and `open`. */
const closerOf = (open: string): string => (open === "{" ? "}" : "]");
/** Inside an open `${…}` or `$[…]`: bash pairs the brackets of `$[…]` (not a bare `{` or `[` in `${…}`); the closer closes. */
function trackCloser(closers: string[], c: string): void {
  if (c === "[" && closers.at(-1) === "]") closers.push("]");
  else if (c === closers.at(-1)) closers.pop();
}

/** Reads the substitution opened at `i` (`$(` or a backquote) as commands one level deeper; returns the index after it. */
function substitution(text: string, i: number, depth: number, reading: Reading): number {
  const backquote = text[i] === "`";
  const start = i + (backquote ? 1 : 2);
  const end = backquote ? closingBackquote(text, start) : closingParen(text, start);
  // `$((…))` is read as `((…))`, so the rules of an arithmetic `((` apply inside it.
  const arithmetic = !backquote && text[start] === "(";
  lex(arithmetic ? text.slice(start - 1, end + 1) : text.slice(start, end), depth + 1, reading);
  return end + 1;
}

/** The substitutions bash runs while it reads an unquoted here-document: the body is data, they are commands. */
function bodySubstitutions(body: string, depth: number, reading: Reading): void {
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "\\") i += 2;
    else if (c === "`" || (c === "$" && body[i + 1] === "(")) i = substitution(body, i, depth, reading);
    else i++;
  }
}

/** `comments`: false for the rest of a line read on its own after a `#` inside `((`, where `#` is a character. */
function lex(text: string, depth: number, reading: Reading, comments = true): void {
  if (depth > MAX_NESTING) throw new CommandTooComplex("nested too deep");
  let words: string[] = [];
  let operators = new Set<number>();
  let wildcards = new Map<number, number>();
  let wildcardAt = -1;
  let current = "";
  let inWord = false;
  /** Whether a `#` here starts a word: set by blanks, separators and operators, cleared by `$IFS`, kept by `\`+newline. */
  let boundary = true;
  const docs = new PendingDocuments();
  /** One entry per open parenthesis: whether it opened a process substitution (`<(…)`, `>(…)`). */
  const parens: boolean[] = [];
  let processSubstitutions = 0;
  /** The parenthesis depth an arithmetic `((` opened at, while one is open. */
  let arithmeticAt = Infinity;
  /** Closers of the `${…}` and `$[…]` open outside double quotes. */
  const expansions: string[] = [];
  /** Set once quotes inside a double-quoted `${…}` leave the reading unsure (bash pairs them, dash does not). */
  let unsure = false;
  const arithmetic = (): boolean => parens.length > arithmeticAt;

  const endWord = (): void => {
    if (inWord) {
      if (wildcardAt !== -1) wildcards.set(words.length, wildcardAt);
      words.push(current);
    }
    wildcardAt = -1;
    current = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length === 0) return;
    const segment: Segment = { words, depth, operators, wildcards };
    words = [];
    operators = new Set();
    wildcards = new Map();
    if (reading.out.length >= MAX_SEGMENTS) throw new CommandTooComplex("too many commands");
    reading.out.push(segment);
    const argv = argvOf(segment);
    // Only `cat` or `tee` makes a here-document data, and not inside a process substitution (`bash <(cat <<EOF`).
    docs.decide(processSubstitutions === 0 && receivesData(argv));
    const inner = nestedText(argv);
    if (inner !== null) lex(inner, depth + 1, reading);
  };
  const beUnsure = (): void => {
    unsure = true;
    reading.unsure = true;
    docs.asCommands();
  };
  const wordSubstitution = (i: number): number => {
    current += text[i] === "`" ? "`…`" : "$(…)";
    inWord = true;
    return substitution(text, i, depth, reading);
  };
  /** The redirection operator at `i` becomes a word of its own; a here-document also queues its delimiter. */
  const operator = (i: number): number => {
    const fd = inWord && /^\d+$/.test(current) && text[i] !== "&" ? current : "";
    if (fd === "") endWord();
    else {
      current = "";
      inWord = false;
      wildcardAt = -1;
    }
    const end = operatorEnd(text, i);
    const op = fd + text.slice(i, end);
    operators.add(words.length);
    words.push(op);
    boundary = true;
    // No here-document inside `${…}`, `$[…]` or `((…))`, nor once the reading is unsure: `<<` is a shift or a character.
    if (!/^\d*<<-?$/.test(op) || expansions.length > 0 || arithmetic() || unsure) return end;
    let at = end;
    while (isBlank(text[at])) at++;
    const read = readDelimiter(text, at, op.endsWith("-"));
    if (read.doc !== null) {
      words.push(read.doc.delimiter);
      docs.add(read.doc);
    }
    return read.end;
  };
  /** After a newline: each queued body, up to its delimiter line, is skipped as data or read as commands. */
  const hereDocuments = (from: number): number => {
    let i = from;
    for (const { doc, data } of docs.take()) {
      const found = findBody(text, i, doc);
      i = found.next;
      // Data only when `cat` or `tee` writes it out and its delimiter line is there; bash still runs the substitutions
      // of an unquoted body. Any other body is read as commands.
      if (!data || !found.terminated) lex(found.body, depth + 1, reading);
      else if (!doc.quoted) bodySubstitutions(found.body, depth, reading);
    }
    return i;
  };
  /** The double-quoted text opened at `from`; returns the index after its closing quote. */
  const doubleQuoted = (from: number): number => {
    inWord = true;
    const closers: string[] = [];
    let i = from + 1;
    while (i < text.length && text[i] !== '"') {
      const d = text[i] as string;
      const after = text[i + 1];
      if (d === "\\" && after === "\n") i += 2;
      else if (d === "\\" && after !== undefined && ('"\\$`'.includes(after) || closers.length > 0)) {
        current += '"\\$`'.includes(after) ? after : d + after;
        i += 2;
      } else if (d === "`" || (d === "$" && after === "(")) i = wordSubstitution(i);
      else if (d === "$" && (after === "{" || after === "[")) {
        closers.push(closerOf(after));
        current += d + after;
        i += 2;
      } else {
        if (closers.length > 0 && d === "'") beUnsure();
        else trackCloser(closers, d);
        current += d;
        i++;
      }
    }
    // A quote closing inside an open `${…}`: bash reads it as a nested quote, this reader as the end of the word.
    if (closers.length > 0) beUnsure();
    return i + 1;
  };
  const openParen = (i: number): void => {
    const processSubstitution = text[i - 1] === "<" || text[i - 1] === ">";
    if (text[i + 1] === "(" && arithmeticAt === Infinity) arithmeticAt = parens.length;
    parens.push(processSubstitution);
    if (!processSubstitution) return;
    processSubstitutions++;
    docs.asCommands();
  };
  const closeParen = (): void => {
    if (parens.pop() === true) processSubstitutions--;
    if (parens.length <= arithmeticAt) arithmeticAt = Infinity;
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
    } else if (c === '"') i = doubleQuoted(i);
    else if (c === "$" && next === "'") {
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
      boundary = false;
      i += next === "{" ? 6 : 4;
    } else if (c === "`" || (c === "$" && next === "(")) i = wordSubstitution(i);
    else if (c === "$" && (next === "{" || next === "[")) {
      expansions.push(closerOf(next));
      current += c + next;
      inWord = true;
      i += 2;
    } else if (isBlank(c)) {
      endWord();
      boundary = true;
      i++;
    } else if (c === "#" && comments && !inWord && boundary && expansions.length === 0) {
      // A comment. Inside `((…))` a `#` is a character, unless `((` opened two subshells: the rest of the line is then
      // read on its own as words, so whichever it is, nothing on it is skipped and its quotes stop at the newline.
      const newline = text.indexOf("\n", i);
      const lineEnd = newline === -1 ? text.length : newline;
      if (arithmetic()) lex(text.slice(i + 1, lineEnd), depth, reading, false);
      i = lineEnd;
    } else if (((c === ">" || c === "<") && next !== "(") || (c === "&" && next === ">")) i = operator(i);
    else if (c === "\n") {
      endCommand();
      // bash starts the bodies after the newline that ends the `${…}` (deferred here too) or the `((…))` (which may also
      // be two subshells, so its bodies start now): none of them is data.
      if (expansions.length > 0 || arithmetic()) docs.asCommands();
      boundary = true;
      i++;
      if (docs.size > 0 && expansions.length === 0) i = hereDocuments(i);
    } else if (";&|()".includes(c)) {
      endCommand();
      // A parenthesis inside `${…}` is a character to bash; a pipe passes the output of a here-document on (`||`, one
      // token read at once, does not).
      if (c === "(" && expansions.length === 0) openParen(i);
      else if (c === ")" && expansions.length === 0) closeParen();
      else if (c === "|" && next !== "|") docs.asCommands();
      boundary = true;
      i += c === "|" && next === "|" ? 2 : 1;
    } else {
      trackCloser(expansions, c);
      if (wildcardAt === -1 && (c === "*" || c === "?" || c === "[")) wildcardAt = current.length;
      current += c;
      inWord = true;
      i++;
    }
  }
  endCommand();
}

/**
 * Every simple command of `command`, nested ones included (M5R18), and whether the reading is `unsure`: some text may run
 * differently in bash than it was read. Throws `CommandTooLong` / `CommandTooComplex`.
 */
export function readCommandsWithDoubt(command: string): { segments: Segment[]; unsure: boolean } {
  if (command.length > MAX_CHECKED_COMMAND) throw new CommandTooLong();
  const reading: Reading = { out: [], unsure: false };
  lex(command, 0, reading);
  return { segments: reading.out, unsure: reading.unsure };
}

/** Every simple command of `command`, nested ones included (M5R18). Throws `CommandTooLong` / `CommandTooComplex`. */
export const readCommands = (command: string): Segment[] => readCommandsWithDoubt(command).segments;
