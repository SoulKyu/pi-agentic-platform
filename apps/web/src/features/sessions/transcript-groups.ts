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

/** Consecutive rows of one author become one run, under one header; summaries, failures and tool-authored messages stand alone. */
export function groupItems(items: readonly TranscriptItem[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const item of items) {
    const author = authorOf(item);
    const last = groups.at(-1);
    if (author !== null && (item.kind === "message" || item.kind === "partial" || item.kind === "tool")) {
      if (last?.kind === "run" && last.author === author) {
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
