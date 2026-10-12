import { plain } from "./dialogs/untrusted.ts";
import type { TranscriptItem } from "./transcript.vm.ts";

const PREVIEW_CHARS = 200;

export interface MinimapTurn {
  readonly number: number;
  readonly key: string;
  readonly preview: string;
  readonly tools: number;
}

/** The DOM id of a transcript row: scoped per screen, so two mounted sessions never share one (keys hold `:` and `#`). */
export const rowId = (scope: string, key: string): string => `row-${scope}-${key}`;

/** One line of untrusted text: control and bidi characters removed, white space collapsed, cut at 200 characters without splitting a surrogate pair. */
export function previewOf(text: string): string {
  const line = plain(text).replace(/\s+/g, " ").trim();
  if (line.length <= PREVIEW_CHARS) return line;
  const lastKept = line.charCodeAt(PREVIEW_CHARS - 1);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? PREVIEW_CHARS - 1 : PREVIEW_CHARS;
  return line.slice(0, end);
}

/** A turn starts at each user message or summary; `turnsBefore` turns lie above the first loaded row. */
export function minimapTurns(items: readonly TranscriptItem[], turnsBefore: number): MinimapTurn[] {
  const turns: Array<{ -readonly [K in keyof MinimapTurn]: MinimapTurn[K] }> = [];
  for (const item of items) {
    if ((item.kind === "message" && item.author === "you") || item.kind === "summary") {
      turns.push({
        number: turnsBefore + turns.length + 1,
        key: item.key,
        preview: previewOf(item.text),
        tools: 0,
      });
    } else if (item.kind === "tool") {
      const turn = turns.at(-1);
      if (turn) turn.tools += 1;
    }
  }
  return turns;
}
