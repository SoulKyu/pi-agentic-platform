/** Here-documents (M5R18): the delimiter word, where a body ends, and which bodies are data. Best effort, see docs/agents/policy.md. */

export interface HereDocument {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** Part of the delimiter was quoted: bash neither expands the body nor joins its continued lines. */
  readonly quoted: boolean;
  /** The delimiter was read as bash reads it: `$'…'`, `$"…"` and substitutions are not decoded, so such a body is never data. */
  readonly exact: boolean;
}

/** Characters that end a word where a here-document delimiter is read. */
const DELIMITER_END = " \t;&|\n()<>";
/** The characters a backslash escapes inside double quotes (a backslash before a newline is a line continuation). */
const DOUBLE_QUOTED_ESCAPES = '"\\$`\n';

/** End of the single-quoted text that starts after `from`, skipping backslash pairs when it is ANSI-C (`$'…'`). */
function singleQuoteEnd(text: string, from: number, ansiC: boolean): number {
  let at = from;
  while (at < text.length && text[at] !== "'") at += ansiC && text[at] === "\\" ? 2 : 1;
  return Math.min(at, text.length);
}

/**
 * The delimiter word at `from` with its quotes and backslashes resolved (`'END OF'`, `"A\"B"`, `\EOF`), and the index
 * after it; `doc` is null when the word is empty (bash refuses the line).
 */
export function readDelimiter(
  text: string,
  from: number,
  stripTabs: boolean,
): { doc: HereDocument | null; end: number } {
  let at = from;
  let delimiter = "";
  let quoted = false;
  let exact = true;
  while (at < text.length && !DELIMITER_END.includes(text[at] as string)) {
    const c = text[at] as string;
    const next = text[at + 1];
    if (c === "$" && next !== undefined && "'\"({[".includes(next)) exact = false;
    if (c === "'" || (c === "$" && next === "'")) {
      const start = at + (c === "$" ? 2 : 1);
      const close = singleQuoteEnd(text, start, c === "$");
      delimiter += text.slice(start, close);
      quoted = true;
      at = close + 1;
    } else if (c === '"' || (c === "$" && next === '"')) {
      quoted = true;
      at += c === "$" ? 2 : 1;
      while (at < text.length && text[at] !== '"') {
        const escaped = text[at] === "\\" && DOUBLE_QUOTED_ESCAPES.includes(text[at + 1] ?? "x");
        if (!escaped) delimiter += text[at];
        else if (text[at + 1] !== "\n") delimiter += text[at + 1];
        at += escaped ? 2 : 1;
      }
      at++;
    } else if (c === "\\") {
      quoted = true;
      delimiter += next ?? "";
      at += 2;
    } else {
      if (c === "`") exact = false;
      delimiter += c;
      at++;
    }
  }
  const end = Math.min(at, text.length);
  return { doc: delimiter === "" ? null : { delimiter, stripTabs, quoted, exact }, end };
}

const endsInContinuation = (line: string): boolean => {
  let count = 0;
  for (let at = line.length - 1; at >= 0 && line[at] === "\\"; at--) count++;
  return count % 2 === 1;
};

/**
 * The body of `doc` from `from` to its delimiter line, the index after that line, and whether the line was there.
 * dash compares every line alone; bash first joins a line ending in an odd run of backslashes to the next one (unquoted
 * delimiter) and strips the tabs of `<<-` at the start of the joined line. The first match of either ends the body, so
 * the body read here is never longer than either shell's. One pass over the lines.
 */
export function findBody(
  text: string,
  from: number,
  doc: HereDocument,
): { body: string; next: number; terminated: boolean } {
  const strip = (line: string) => (doc.stripTabs ? line.replace(/^\t+/, "") : line);
  let lineStart = from;
  let joinedStart = from;
  let joined = "";
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const next = newline === -1 ? text.length : newline + 1;
    const line = text.slice(lineStart, newline === -1 ? text.length : newline);
    if (strip(line) === doc.delimiter) return { body: text.slice(from, lineStart), next, terminated: true };
    const continued = !doc.quoted && endsInContinuation(line);
    joined += continued ? line.slice(0, -1) : line;
    if (!continued) {
      if (strip(joined) === doc.delimiter)
        return { body: text.slice(from, joinedStart), next, terminated: true };
      joined = "";
      joinedStart = next;
    }
    if (newline === -1) return { body: text.slice(from), next, terminated: false };
    lineStart = next;
  }
}

/** The here-documents of one line and what is known of each receiver; every operation is O(1) per document. */
export class PendingDocuments {
  private readonly queue: { readonly doc: HereDocument; data: boolean }[] = [];
  /** Documents whose receiving command has ended, and documents that something on their line pipes on. */
  private decided = 0;
  private pipedOn = 0;

  get size(): number {
    return this.queue.length;
  }

  add(doc: HereDocument): void {
    this.queue.push({ doc, data: false });
  }

  /** The command that receives the undecided documents has ended: `data` says whether it only writes them out. */
  decide(data: boolean): void {
    for (const entry of this.queue.slice(this.decided)) entry.data = data;
    this.decided = this.queue.length;
  }

  /** A pipe, a process substitution or a reading that lost track follows every document queued so far: none is data. */
  asCommands(): void {
    this.pipedOn = this.queue.length;
  }

  /** The documents of the line that just ended, each with whether its body is data; the queue starts over. */
  take(): { doc: HereDocument; data: boolean }[] {
    const out = this.queue.map((entry, k) => ({
      doc: entry.doc,
      data: entry.data && entry.doc.exact && k >= this.pipedOn,
    }));
    this.queue.length = 0;
    this.decided = 0;
    this.pipedOn = 0;
    return out;
  }
}
