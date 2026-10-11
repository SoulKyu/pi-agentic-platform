import { UI_LIMITS } from "@pap/contracts";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The one clip of a session name (M2R92): Pi's name comes from the Pi CLI, an extension or the model, so it may be
 * long or hold control or bidi characters. The database (`length(name) <= 256`), the contract (`SessionName`) and the
 * list all accept what this returns. Whitespace of any kind becomes one space; the other control and format
 * characters are removed.
 */
export function nameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw
    .replace(LONE_SURROGATE, "\ufffd")
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  if (!flat) return null;
  // Cut by code points, so a surrogate pair is never split; the cut may end on a space.
  return [...flat].slice(0, UI_LIMITS.name).join("").trimEnd();
}
