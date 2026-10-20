import type { InterleaveRow } from "../../stores/thread-interleave.ts";
import type { MessageItem, PartialItem, ToolItem, TranscriptItem } from "./transcript.vm.ts";

/** Rows that stand under one author's header: the agent's text, its tool calls and the reply being written; or your messages. */
export interface AuthorRun {
  readonly kind: "run";
  readonly author: "agent" | "you";
  /** The key of the run's first row: it does not change as the run grows. */
  readonly key: string;
  readonly items: ReadonlyArray<MessageItem | PartialItem | ToolItem>;
}
export interface LoneRow {
  readonly kind: "lone";
  readonly key: string;
  readonly item: TranscriptItem;
}
export type TranscriptGroup = AuthorRun | LoneRow;

function authorOf(item: TranscriptItem): "agent" | "you" | null {
  if (item.kind === "partial" || item.kind === "tool") return "agent";
  if (item.kind === "message" && item.author !== "tool") return item.author;
  return null;
}

const marked = (item: TranscriptItem | undefined): boolean =>
  item?.kind === "message" && item.unverified === true;

/**
 * Consecutive rows of one author become one run, under one header; summaries, failures and tool-authored messages stand
 * alone. A row named in `breaks` starts a run of its own (a card, a day or a pause stands before it).
 */
export function groupItems(
  items: readonly TranscriptItem[],
  breaks?: ReadonlySet<string>,
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const item of items) {
    const author = authorOf(item);
    const last = groups.at(-1);
    if (author !== null && (item.kind === "message" || item.kind === "partial" || item.kind === "tool")) {
      // A row pap did not send stands alone, so its author line can say so.
      const mixed = marked(item) || (last?.kind === "run" && marked(last.items[0]));
      if (last?.kind === "run" && last.author === author && !breaks?.has(item.key) && !mixed) {
        groups[groups.length - 1] = { ...last, items: [...last.items, item] };
      } else {
        groups.push({ kind: "run", author, key: item.key, items: [item] });
      }
    } else {
      groups.push({ kind: "lone", key: item.key, item });
    }
  }
  return groups;
}

/** What an agent thread's interleave sees of a row: its time, whose it is and its text. */
export function interleaveRow(item: TranscriptItem): InterleaveRow {
  const author = authorOf(item) ?? "other";
  const at = item.kind === "message" || item.kind === "tool" ? (item.at ?? null) : null;
  return {
    key: item.key,
    at,
    author,
    text: item.kind === "message" || item.kind === "partial" ? item.text : "",
  };
}
