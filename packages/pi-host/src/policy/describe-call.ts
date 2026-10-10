import { EXEC_TOOLS } from "./categories.ts";
import type { EditReview } from "./target-path.ts";

export const MAX_REVIEW_BYTES = 32 * 1024;

export type CallDescription =
  { readonly reviewable: true; readonly message: string } | { readonly reviewable: false };

// Whitespace runs longer than 32 characters collapse into a marker; every other character the eye cannot
// see (controls except \n and \t, format, separator, private-use, unassigned, lone surrogates) is spelled out.
const LONG_BLANK_RUN = /[\p{Zs}\t\n]{33,}/u;
const HIDDEN_OR_BLANK_RUN = new RegExp(
  `${LONG_BLANK_RUN.source}|[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}]`,
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

function showHidden(text: string, counter: { hidden: number }): string {
  return text.replace(HIDDEN_OR_BLANK_RUN, (match) => {
    if (match.length > 32) return blankRunMarker(match);
    if (match === "\n" || match === "\t") return match;
    counter.hidden += 1;
    return `\\u{${(match.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}

function payloadOf(toolName: string, input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  if (EXEC_TOOLS.has(toolName) && typeof command === "string") return command;
  const json = JSON.stringify(input ?? {});
  if (json === undefined) throw new TypeError("the tool input cannot be described");
  return json;
}

/**
 * The text of an approval dialog: a header (size, lines, hidden characters), where a write lands, then the
 * complete call. A payload above the review cap is not described: the caller must not ask about it.
 */
export function describeCall(toolName: string, input: unknown, review?: EditReview): CallDescription {
  const payload = payloadOf(toolName, input);
  if (Buffer.byteLength(payload, "utf8") > MAX_REVIEW_BYTES) return { reviewable: false };
  const counter = { hidden: 0 };
  const call = `${showHidden(toolName, counter)}: ${showHidden(payload, counter)}`;
  const destination = review
    ? [
        `→ ${review.target === undefined ? "unknown location" : showHidden(review.target, counter)} (${review.why})`,
      ]
    : [];
  const header = [
    plural([...payload].length, "character"),
    plural(payload.split("\n").length, "line"),
    ...(counter.hidden ? [`${plural(counter.hidden, "hidden character")} shown escaped`] : []),
  ].join(", ");
  return { reviewable: true, message: [header, ...destination, call].join("\n") };
}
