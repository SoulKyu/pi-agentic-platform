export type AnsiTone = "dim" | "error" | "ok" | "you" | "agent" | "attention" | "text";
export interface AnsiSpan {
  readonly text: string;
  readonly tone: AnsiTone | null;
  readonly bold: boolean;
  readonly faint: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}
type Style = Omit<AnsiSpan, "text">;

/** At most this many spans per line; what follows is one plain span (bounded render, M2-RT-42). */
export const MAX_SPANS = 256;
const PLAIN: Style = { tone: null, bold: false, faint: false, italic: false, underline: false };
/** SGR 30–37 and 90–97, in order: black, red, green, yellow, blue, magenta, cyan, white (owner C2, DESIGN.md §9.2). */
const SGR_COLOURS: readonly AnsiTone[] = ["dim", "error", "ok", "you", "agent", "attention", "agent", "text"];
// Bidi controls and control characters go first, except tab, ESC and BEL (they start or end the sequences parsed
// below); a BEL left in the text after parsing is removed with the sequences.
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const UNSAFE = /[\p{Cf}\u0000-\u0006\u0008\u000a-\u001a\u001c-\u001f\u007f-\u009f]/gu;
// eslint-disable-next-line no-control-regex -- matches BEL and a lone ESC, which no sequence consumed
const LEFTOVER = /[\u0007\u001b]/g;
// CSI (any final byte; only `m` is applied), OSC (ended by BEL or ST), pi-tui's cursor marker, other two-byte escapes.
const ESC = "\\u001b";
const BEL_CHAR = "\\u0007";
const ESCAPES = new RegExp(
  `${ESC}(?:\\[([0-?]*)([ -/]*)([@-~])|\\][^${BEL_CHAR}${ESC}]*(?:${BEL_CHAR}|${ESC}\\\\)?|_pi:c${BEL_CHAR}|[@-Z\\\\-_])`,
  "g",
);
const DIGITS = /^\d+$/;

function applySgr(style: Style, params: string): Style {
  // A private-marker sequence (`CSI ? 25 m`) is not a colour; a parameter that is not a plain number is skipped.
  if (/[<=>?]/.test(params)) return style;
  const codes =
    params === ""
      ? [0]
      : params.split(";").map((part) => (part === "" ? 0 : DIGITS.test(part) ? Number(part) : -1));
  let next = style;
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at] ?? 0;
    if (code === 0) next = PLAIN;
    else if (code === 1) next = { ...next, bold: true };
    else if (code === 2) next = { ...next, faint: true };
    else if (code === 3) next = { ...next, italic: true };
    else if (code === 4) next = { ...next, underline: true };
    else if (code === 22) next = { ...next, bold: false, faint: false };
    else if (code === 23) next = { ...next, italic: false };
    else if (code === 24) next = { ...next, underline: false };
    else if (code >= 30 && code <= 37) next = { ...next, tone: SGR_COLOURS[code - 30] ?? null };
    else if (code >= 90 && code <= 97) next = { ...next, tone: SGR_COLOURS[code - 90] ?? null };
    else if (code === 39) next = { ...next, tone: null };
    // 256-colour and truecolor carry their own arguments: skipped, the colour ignored (owner C2).
    else if (code === 38 || code === 48) at += codes[at + 1] === 5 ? 2 : codes[at + 1] === 2 ? 4 : 0;
    // Backgrounds (40–47, 100–107), inverse (7, 27) and the rest: ignored.
  }
  return next;
}

/** One line of extension text as styled spans. Every call starts plain: a cut line cannot leave a style open on the next. */
export function parseAnsi(raw: string): AnsiSpan[] {
  const text = raw.replace(UNSAFE, "");
  const spans: AnsiSpan[] = [];
  let style = PLAIN;
  let last = 0;
  let capped = false;
  for (const match of text.matchAll(ESCAPES)) {
    const chunk = text.slice(last, match.index).replace(LEFTOVER, "");
    if (chunk) {
      if (spans.length === MAX_SPANS - 1) {
        capped = true;
        break;
      }
      spans.push({ text: chunk, ...style });
    }
    last = match.index + match[0].length;
    // Only a bare `CSI params m` is SGR: intermediate bytes (`CSI 3 1 SP m`) make it another sequence.
    if (match[3] === "m" && !match[2]) style = applySgr(style, match[1] ?? "");
  }
  const rest = text.slice(last).replace(ESCAPES, "").replace(LEFTOVER, "");
  if (rest) spans.push({ text: rest, ...(capped ? PLAIN : style) });
  return spans;
}

export const plainText = (raw: string): string =>
  parseAnsi(raw)
    .map((span) => span.text)
    .join("");
