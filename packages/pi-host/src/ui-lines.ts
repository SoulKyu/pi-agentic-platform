export interface LineBounds {
  readonly lines: number;
  readonly lineChars: number;
  /** UTF-8 bytes of the whole record's text, a newline counted per line. */
  readonly bytes: number;
}

/** Well under the 1 MiB frame: a panel or a widget never takes a frame of its own (spec C §4.2). */
export const UI_RECORD_BYTES = 256 * 1024;

// One pass, left to right; at each position the first alternative that matches wins.
//  1. CSI: kept only when it is a plain SGR (digits and `;`, final `m`); cursor moves, erases, private modes,
//     mouse and kitty-keyboard requests are dropped whole.
//  2. A string introduced by ESC ] (OSC: titles, `]8` hyperlinks, clipboard), P (DCS), X, ^ or _ (APC/PM/SOS) runs to
//     BEL or ST, or to the end of the line when it never ends.
//  3. Any other ESC sequence, and a lone ESC.
//  4. Every other control character but the tab: C0 (BEL, backspace, CR, LF…), DEL and C1 (a one-byte CSI or OSC).
const ESC = "\u001b";
const TERMINAL_TEXT = new RegExp(
  [
    `${ESC}\\[([0-?]*)([ -/]*)([@-~])?`,
    `${ESC}[\\]PX^_][^]*?(?:\\u0007|${ESC}\\\\|$)`,
    `${ESC}[ -/]*[0-~]?`,
    "[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f]",
  ].join("|"),
  "g",
);

const ALLOWED_SGR: ReadonlySet<number> = new Set([
  0, 1, 2, 3, 4, 22, 23, 24, 30, 31, 32, 33, 34, 35, 36, 37, 39, 90,
]);

/**
 * The allow-list pass over one SGR parameter list: reset, bold, dim, italic, underline and their resets, the 8 basic
 * foregrounds, the default foreground and bright black. Everything else goes, including backgrounds, inverse (7),
 * blink (5, 6), conceal (8), and the arguments that follow an extended colour (38 or 48 with `;5;n` or `;2;r;g;b`),
 * which would otherwise read as codes of their own. An empty list is a reset and stays one.
 */
function allowedSgr(params: string): string {
  const tokens = params.split(";");
  const kept: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i] === "" ? 0 : Number(tokens[i]);
    if (code === 38 || code === 48) {
      const mode = Number(tokens[i + 1]);
      i += mode === 5 ? 2 : mode === 2 ? 4 : 0;
    } else if (ALLOWED_SGR.has(code)) kept.push(code);
  }
  return kept.length > 0 ? `${ESC}[${kept.join(";")}m` : "";
}

/**
 * Extension text is untrusted. What stays is text and the SGR subset above, which the web client maps to role tokens;
 * everything else a terminal would act on is removed here, at the source.
 */
function inert(line: string): string {
  return line.replace(TERMINAL_TEXT, (match, params?: string, intermediates?: string, final?: string) =>
    match.startsWith("\u001b[") && final === "m" && !intermediates && /^[0-9;]*$/.test(params ?? "")
      ? allowedSgr(params ?? "")
      : "",
  );
}

/** A cut can leave half an SGR sequence or half a surrogate pair at the end. */
const CUT_TAIL = new RegExp(`(?:${ESC}(?:\\[[0-9;]*)?|[\\uD800-\\uDBFF])$`);

/** The lines of a panel or a widget as the browser may receive them: inert, and cut to count, length and bytes. */
export function boundLines(lines: readonly unknown[], bounds: LineBounds): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const raw of lines.slice(0, bounds.lines)) {
    const line = inert(typeof raw === "string" ? raw : "")
      .slice(0, bounds.lineChars)
      .replace(CUT_TAIL, "");
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > bounds.bytes) break;
    out.push(line);
  }
  return out;
}
