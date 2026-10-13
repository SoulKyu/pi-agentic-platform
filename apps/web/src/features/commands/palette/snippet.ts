import { SNIPPET_CLOSE, SNIPPET_OPEN } from "@pap/contracts";

// Control and format characters other than the two markers: never shown (lint refuses control characters written in
// a regular expression, so the markers are compared as strings before this test).
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;
const ZWJ = "\u200D"; // joins emoji sequences; the other format characters (bidi, zero-width spaces) are dropped
const LINE_BREAK = /[\t\n\r]/;

/** A snippet's text and matches (M4R107): the markers come from SQLite only; everything stays text. */
export function snippetParts(snippet: string): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let hit = false;
  let text = "";
  const flush = () => {
    if (text !== "") parts.push({ text, hit });
    text = "";
  };
  for (const char of snippet) {
    if (char === SNIPPET_OPEN) {
      if (!hit) {
        flush();
        hit = true;
      }
    } else if (char === SNIPPET_CLOSE) {
      if (hit) {
        flush();
        hit = false;
      }
    } else if (LINE_BREAK.test(char)) text += " ";
    else if (char === ZWJ || !INVISIBLE.test(char)) text += char;
  }
  flush();
  return parts;
}
