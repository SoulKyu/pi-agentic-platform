import { clip, type ClipLimits } from "./dialogs/untrusted.ts";

/** A visible piece of a fenced body, or a run of hidden characters that was removed (`hidden` = how many). */
export type Piece = { readonly text: string } | { readonly hidden: number };

// Controls (except tab and newline) and format characters: bidi, zero-width, Unicode tags. One run = adjacent ones.
const RUN = /(?:(?![\t\n])[\p{Cc}\p{Cf}])+/gu;
// A noncharacter no run can contain; one in the text itself is shown as the replacement character first.
const MARK = "\uFFFF";

/**
 * A fenced body as pieces: the hidden characters are never drawn, each contiguous run becomes one counted marker.
 * The clip counts a marker as a few characters; a cut never leaves half a marker.
 */
export function pieces(raw: string, limits: ClipLimits, expanded: boolean) {
  const marked = raw
    .replaceAll(MARK, "\uFFFD")
    .replace(RUN, (run) => `${MARK}${Array.from(run).length}${MARK}`);
  const cut = clip(marked, limits);
  const text = expanded ? marked : cut.shown;
  // A cut inside a marker leaves an odd number of marks: the half marker goes, the ellipsis stays.
  const odd = Array.from(text).filter((one) => one === MARK).length % 2 === 1;
  const shown = odd ? `${text.slice(0, text.lastIndexOf(MARK))}${text.endsWith("…") ? "…" : ""}` : text;
  const out: Piece[] = [];
  shown.split(/\uFFFF(\d+)\uFFFF/).forEach((part, index) => {
    if (index % 2 === 1) out.push({ hidden: Number(part) });
    else if (part !== "") out.push({ text: part });
  });
  return { pieces: out, clipped: cut.clipped };
}
