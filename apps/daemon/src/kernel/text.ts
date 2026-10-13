/** A half of a surrogate pair without its other half: what a careless cut or broken input leaves. Global: `replace` only. */
export const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The longest id the contracts carry (entries, leaves, sessions, projects): an id is a key, refused when longer, never cut. */
export const MAX_ID_CHARS = 128;

/**
 * At most `max` UTF-16 units (what `z.string().max` counts), `marker` included when the text was cut, never ending on the
 * first half of a surrogate pair. `max` is at least the marker's length.
 */
export function cutUnits(text: string, max: number, marker = ""): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - marker.length);
  const last = text.charCodeAt(keep - 1);
  const end = keep > 0 && last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep;
  return `${text.slice(0, end)}${marker}`;
}

// Format characters (Cf) go, bidi controls and the BOM among them, except the zero width joiner: without it an emoji
// sequence falls apart. Variation selectors are not Cf and stay.
const FORMAT_EXCEPT_ZWJ = /(?!\u200D)\p{Cf}/gu;
// NEL and the line and paragraph separators are line breaks like any other; `\s` covers the separators.
const LINE_OR_SPACE = /[\s\u0085]+/gu;
const INVISIBLE_ONLY = /^(?:\u200D|\uFE0E|\uFE0F| )*$/u;

/**
 * One line of display text from untrusted input (a session name, a project name, a message preview): whitespace of any
 * kind becomes one space, other control and format characters go (the emoji joiner stays), cut to `maxCodePoints` code
 * points (never half a pair), trimmed. Null when nothing visible is left.
 */
export function cleanLabel(raw: unknown, maxCodePoints: number): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(FORMAT_EXCEPT_ZWJ, "")
    .replace(LINE_OR_SPACE, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  if (INVISIBLE_ONLY.test(flat)) return null;
  return [...flat].slice(0, maxCodePoints).join("").trimEnd();
}
