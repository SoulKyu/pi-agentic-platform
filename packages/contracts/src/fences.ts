export interface Fence {
  /** Offset of the first character of the opening line. */
  readonly start: number;
  /** The info string's first word, lower-cased. */
  readonly lang: string;
  readonly body: string;
}

interface Scanned extends Fence {
  /** Offset just after the opening line's text (before its line break). */
  readonly openEnd: number;
}

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function scan(text: string): Scanned[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const found: Scanned[] = [];
  let offset = 0;
  let open: {
    start: number;
    openEnd: number;
    indent: number;
    char: string;
    length: number;
    lang: string;
  } | null = null;
  let body: string[] = [];
  const finish = (): void => {
    if (open === null) return;
    found.push({ start: open.start, openEnd: open.openEnd, lang: open.lang, body: body.join("\n") });
    open = null;
    body = [];
  };
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (open === null) {
      const match = OPEN.exec(line);
      const fence = match?.[2] ?? "";
      const info = match?.[3] ?? "";
      if (match !== null && !(fence.startsWith("`") && info.includes("`"))) {
        const lang = (info.trim().split(/\s+/)[0] ?? "").toLowerCase();
        open = {
          start: offset,
          openEnd: offset + raw.length,
          indent: (match[1] ?? "").length,
          char: fence.charAt(0),
          length: fence.length,
          lang,
        };
      }
    } else {
      const close = OPEN.exec(line);
      const run = close?.[2] ?? "";
      if (
        close !== null &&
        run.startsWith(open.char) &&
        run.length >= open.length &&
        close[3]?.trim() === ""
      ) {
        finish();
      } else {
        let cut = 0;
        while (cut < open.indent && line.charAt(cut) === " ") cut += 1;
        body.push(line.slice(cut));
      }
    }
    offset += raw.length + 1;
  }
  finish();
  return found;
}

/**
 * The top-level CommonMark fences of a text: up to 3 spaces of indent, then at least three backticks (no backtick in the
 * info) or three tildes; the closing fence uses the same character, at least the same length, and only spaces after it. An
 * unclosed fence runs to the end. Body lines lose up to the opening's indent. A fence inside a block quote or a list is
 * not top-level and is not found. The daemon and the web both read replies through this, so they agree on every index.
 */
export function scanFences(text: string): Fence[] {
  return scan(text).map(({ start, lang, body }) => ({ start, lang, body }));
}

/** The index (in {@link scanFences}) of the fence whose opening line holds `offset`; null elsewhere. */
export function fenceIndexAt(text: string, offset: number): number | null {
  const index = scan(text).findIndex((fence) => offset >= fence.start && offset <= fence.openEnd);
  return index < 0 ? null : index;
}
