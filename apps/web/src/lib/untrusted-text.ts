// Controls except tab and new line, then format characters (bidi, zero-width) and line and paragraph separators. A joiner
// (U+200D) stays only between two pictographs (an optional emoji presentation selector or skin tone before it), so an
// emoji sequence survives; a lone or edge joiner goes like every other format character.
// Known and accepted: a joiner between two pictographs survives whatever the pictographs are, so a chain of
// pictograph, joiner, pictograph, joiner... keeps one invisible bit per gap (joiner or none). \p{Extended_Pictographic}
// also holds the copyright and registered signs, so \u00a9 and \u00ae count as pictographs here.
const HIDDEN =
  /(?![\t\n])\p{Cc}|(?!(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}]\ufe0f?)\u200d(?=\p{Extended_Pictographic}))[\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Text an agent or a run wrote, as it is shown and as it is injected: hidden characters are removed, never drawn. */
export const stripHidden = (text: string): string => text.replace(HIDDEN, "");

/** What an agent's one-line text (a request's title, a run's source) shows at most, in UTF-16 units. */
export const LINE_UNITS = 500;

/** At most `max` UTF-16 units, the marker included, never ending on half of a surrogate pair. */
export function cutUnits(text: string, max: number, marker = "\u2026"): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - marker.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

/** An agent's one-line text as shown: hidden characters removed, then clipped. */
export const lineOf = (text: string): string => cutUnits(stripHidden(text), LINE_UNITS);

export const FOLD_LINES = 16;

/** The first `max` lines of a text and how many lines it has; `folded` says lines were left out. */
export function foldLines(
  text: string,
  max: number = FOLD_LINES,
): { readonly shown: string; readonly total: number; readonly folded: boolean } {
  const lines = text.split("\n");
  return {
    shown: lines.length > max ? lines.slice(0, max).join("\n") : text,
    total: lines.length,
    folded: lines.length > max,
  };
}

/** An unguessable fence id (12 hex), so text inside a fence cannot forge its closing line. */
export function newFenceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
