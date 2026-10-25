const KEEP = /https?:\/\/\S+|`[^`]*`|\{\w+\}|\d:\d/g;

/** French typography: a space before ? ! : ; » or after « becomes U+202F. URLs, times, {placeholders} and `code` stay as written. */
export function frenchSpacing(text: string): string {
  let last = 0;
  let out = "";
  const space = (part: string): string =>
    part.replace(/[ \u00a0]+([?!:;»])/g, "\u202f$1").replace(/«[ \u00a0]+/g, "«\u202f");
  for (const kept of text.matchAll(KEEP)) {
    out += space(text.slice(last, kept.index)) + kept[0];
    last = kept.index + kept[0].length;
  }
  return out + space(text.slice(last));
}
