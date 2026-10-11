import { UI_LIMITS } from "@pap/contracts";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Format characters (Cf) are removed, bidi controls and the BOM among them, except the zero width joiner: without it
// an emoji sequence (a family, a profession) falls apart. Variation selectors are not Cf and stay.
const FORMAT_EXCEPT_ZWJ = /(?!\u200D)\p{Cf}/gu;
// NEL and the line and paragraph separators are line breaks like any other; `\s` covers the separators.
const LINE_OR_SPACE = /[\s\u0085]+/gu;
const INVISIBLE_ONLY = /^(?:\u200D|\uFE0E|\uFE0F| )*$/u;

/**
 * The one clip of a session name (M2R92): Pi's name comes from the Pi CLI, an extension or the model, so it may be
 * long or hold control or bidi characters. The database (`length(name) <= 256`), the contract (`SessionName`) and the
 * list all accept what this returns. Whitespace of any kind becomes one space; the other control and format
 * characters are removed (the joiner of emoji sequences is kept).
 */
export function nameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw
    .replace(LONE_SURROGATE, "�")
    .replace(FORMAT_EXCEPT_ZWJ, "")
    .replace(LINE_OR_SPACE, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  if (INVISIBLE_ONLY.test(flat)) return null;
  // Cut by code points, so a surrogate pair is never split; the cut may end on a space.
  return [...flat].slice(0, UI_LIMITS.name).join("").trimEnd();
}
