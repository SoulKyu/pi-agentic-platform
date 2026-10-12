import type { EditReview } from "./target-path.ts";

export const MAX_REVIEW_BYTES = 32 * 1024;
// Bounds the work: whitespace collapses, so a long raw payload can still fit, but not an endless one.
const MAX_RAW_BYTES = 32 * MAX_REVIEW_BYTES;

export type CallDescription =
  { readonly reviewable: true; readonly message: string } | { readonly reviewable: false };

// Whitespace runs longer than 32 characters collapse into a marker; every other character the eye cannot
// see (controls except \n and \t, format, separator, private-use, unassigned, default-ignorable, lone
// surrogates) is spelled out. So are the lookalike blanks (R91, M5R31): U+00A0, U+1680, U+2000-U+200A, U+202F,
// U+205F, U+3000 and the braille blank U+2800, which pass for a space or an empty name.
const LONG_BLANK_RUN = /[\p{Zs}\t\n]{33,}/u;
const LOOKALIKE_BLANKS = "\\u{00A0}\\u{1680}\\u{2000}-\\u{200A}\\u{202F}\\u{205F}\\u{3000}\\u{2800}";
const HIDDEN_OR_BLANK_RUN = new RegExp(
  `${LONG_BLANK_RUN.source}|[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}${LOOKALIKE_BLANKS}]`,
  "gu",
);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function blankRunMarker(run: string): string {
  const newlines = [...run].filter((c) => c === "\n").length;
  const tabs = [...run].filter((c) => c === "\t").length;
  const parts = [
    ...(newlines ? [plural(newlines, "newline")] : []),
    ...(tabs ? [plural(tabs, "tab")] : []),
    ...(run.length - newlines - tabs ? [plural(run.length - newlines - tabs, "space")] : []),
  ];
  return `⟨${parts.join(", ")}⟩`;
}

export function showHidden(text: string, counter: { hidden: number }): string {
  return text.replace(HIDDEN_OR_BLANK_RUN, (match) => {
    if (match.length > 32) return blankRunMarker(match);
    if (match === "\n" || match === "\t") return match;
    counter.hidden += 1;
    return `\\u{${(match.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}

function payloadOf(input: unknown, exec: boolean): string {
  const command = (input as { command?: unknown } | null)?.command;
  if (exec && typeof command === "string") return command;
  const json = JSON.stringify(input ?? {});
  if (json === undefined) throw new TypeError("the tool input cannot be described");
  return json;
}

export interface CallView {
  /** The call is a shell command of a built-in shell tool: show the command alone, not the whole input. */
  readonly exec: boolean;
  readonly review?: EditReview | undefined;
}

/**
 * The text of an approval dialog: a header (size, lines, hidden characters), where a write lands, then the
 * complete call. When that text, escapes included, is above the review cap it is not produced: the caller
 * must not ask about the call.
 */
export function describeCall(toolName: string, input: unknown, view: CallView): CallDescription {
  const payload = payloadOf(input, view.exec);
  if (Buffer.byteLength(payload, "utf8") > MAX_RAW_BYTES) return { reviewable: false };
  const counter = { hidden: 0 };
  const call = `${showHidden(toolName, counter)}: ${showHidden(payload, counter)}`;
  const destination = view.review
    ? [
        `→ ${view.review.target === undefined ? "unknown location" : showHidden(view.review.target, counter)} (${view.review.why})`,
      ]
    : [];
  const header = [
    plural([...payload].length, "character"),
    plural(payload.split("\n").length, "line"),
    ...(counter.hidden ? [`${plural(counter.hidden, "hidden character")} shown escaped`] : []),
  ].join(", ");
  const message = [header, ...destination, call].join("\n");
  return Buffer.byteLength(message, "utf8") > MAX_REVIEW_BYTES
    ? { reviewable: false }
    : { reviewable: true, message };
}
