import { cutUnits, stripHidden } from "../../../lib/untrusted-text.ts";

export const MAX_QUOTE = 20_000;
const MARGIN = 8; // the s2 spacing token, in px
/** The bar's size before it is measured (one frame at most): about two buttons. */
export const GUESS = { width: 240, height: 44 } as const;

/** A selection as a Markdown quote: hidden characters gone, at most 20 000 units, "> " per line, ">" for an empty one. */
export function quoteOf(selection: string): string {
  const clean = stripHidden(selection).replace(/\r\n?/g, "\n").trimEnd();
  const clipped = cutUnits(clean, MAX_QUOTE, "");
  const lines = clipped.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
  return `${lines.join("\n")}\n\n`;
}

/** TO KNOWLEDGE: the fixed request, a blank line, then the quote. */
export const knowledgeRequest = (line: string, quote: string): string => `${line}\n\n${quote}`;

/** Puts `insert` at the caret, on a line of its own when the caret is mid-line; returns the caret after it. */
export function insertAt(
  text: string,
  caret: number,
  insert: string,
): { readonly text: string; readonly caret: number } {
  const at = Math.min(Math.max(caret, 0), text.length);
  const lead = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
  return {
    text: `${text.slice(0, at)}${lead}${insert}${text.slice(at)}`,
    caret: at + lead.length + insert.length,
  };
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** The toolbar's corner: above the selection, centred on it and clamped into the viewport; below it when there is no room. */
export function placeToolbar(
  rect: Box,
  view: { readonly width: number; readonly height: number },
  size: { readonly width: number; readonly height: number } = GUESS,
): { readonly left: number; readonly top: number } {
  const centre = (rect.left + rect.right) / 2 - size.width / 2;
  const left = Math.max(MARGIN, Math.min(centre, view.width - size.width - MARGIN));
  const above = rect.top - size.height - MARGIN;
  const top = above >= MARGIN ? above : Math.min(rect.bottom + MARGIN, view.height - size.height - MARGIN);
  return { left, top };
}
