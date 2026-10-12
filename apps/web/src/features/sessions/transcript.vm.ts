import type { Translate } from "../../i18n/index.ts";
import type { MessageView, ToolCallView } from "../../stores/row-view.ts";
import type { SessionView, ToolView } from "../../stores/session-reducer.ts";

const BYTES_PER_KB = 1024;

export type ToolStatus = "running" | "done" | "failed" | "waiting";

export interface MessageItem {
  readonly kind: "message";
  readonly key: string;
  readonly author: "agent" | "you" | "tool";
  readonly text: string;
  readonly thinking: string;
  readonly entryId: string | null;
}

export interface ToolItem {
  readonly kind: "tool";
  /** `${owner}:${toolCallId}#${occurrence}`: Pi's call ids are not unique, so the id alone cannot key a row (M2R126). */
  readonly key: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly summary: string;
  readonly status: ToolStatus;
  readonly preview: string;
  /** How many characters the whole output has when `preview` is only its start, else null. */
  readonly truncatedChars: number | null;
  readonly argsTruncated: boolean;
  /** The entry Pi wrote for the result: call ids repeat across turns, so the daemon needs it to find this call's output. */
  readonly resultEntryId: string | null;
  /** How big the result was when the server did not send it at all (too big for a message), else null. */
  readonly omittedBytes: number | null;
}

export interface SummaryItem {
  readonly kind: "summary";
  readonly key: string;
  readonly variant: "compaction" | "branch";
  readonly text: string;
  readonly tokensBefore: number | null;
  readonly entryId: string | null;
}

export interface FailureItem {
  readonly kind: "failure";
  readonly key: string;
  readonly text: string;
}

export interface PartialItem {
  readonly kind: "partial";
  readonly key: "partial";
  readonly text: string;
  readonly thinking: string;
}

export type TranscriptItem = MessageItem | ToolItem | SummaryItem | FailureItem | PartialItem;

/** A call that has not been answered yet, while the items are being built. */
interface OpenCall {
  readonly index: number;
  /** Position of the assistant message among the messages: "nearest" is measured in messages. */
  readonly at: number;
  readonly item: ToolItem;
}

const omittedText = (message: MessageView, t: Translate): string =>
  t("session.omitted", { size: Math.max(1, Math.round((message.omittedBytes ?? 0) / BYTES_PER_KB)) });

function toolItem(owner: string, call: ToolCallView, occurrence: number): ToolItem {
  return {
    kind: "tool",
    key: `${owner}:${call.id}#${occurrence}`,
    toolCallId: call.id,
    name: call.name,
    summary: call.summary,
    status: "waiting",
    preview: "",
    truncatedChars: null,
    argsTruncated: call.argsTruncated,
    resultEntryId: null,
    omittedBytes: null,
  };
}

/**
 * The answer goes to the nearest message before it that still has an open call of this id, and to the earliest
 * open call in that message (a turn's results come in call order). A call nobody answered stays open, so an old
 * one never takes the result of a later turn.
 */
function answered(open: OpenCall[], message: MessageView): OpenCall | undefined {
  const mine = open.filter((call) => call.item.toolCallId === message.toolCallId);
  const nearest = mine.at(-1)?.at;
  return mine.find((call) => call.at === nearest);
}

const withLive = (item: ToolItem, live: ToolView | undefined): ToolItem =>
  live ? { ...item, status: live.status, preview: live.preview } : item;

function uniqueKeys(items: TranscriptItem[]): TranscriptItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    let key = item.key;
    for (let n = 1; taken.has(key); n++) key = `${item.key}~${n}`;
    taken.add(key);
    return key === item.key ? item : ({ ...item, key } as TranscriptItem);
  });
}

/** The rows of a view; the words they carry (the omitted-message note, the model-error fallback) come in `translate`, so a locale switch shows in them. */
export function transcriptItems(view: SessionView, translate: Translate): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const open: OpenCall[] = [];
  view.messages.forEach((message, at) => {
    const placeholder = message.omittedBytes === null ? null : omittedText(message, translate);
    if (message.role === "toolResult" && message.toolCallId !== null) {
      const call = answered(open, message);
      if (call) {
        open.splice(open.indexOf(call), 1);
        items[call.index] = {
          ...call.item,
          status: message.isError ? "failed" : "done",
          preview: message.text,
          truncatedChars: message.truncatedChars,
          resultEntryId: message.entryId,
          omittedBytes: message.omittedBytes,
        };
        return;
      }
    }
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      items.push({
        kind: "summary",
        key: message.key,
        variant: message.role === "compactionSummary" ? "compaction" : "branch",
        text: message.text,
        tokensBefore: message.tokensBefore,
        entryId: message.entryId,
      });
      return;
    }
    const author = message.role === "user" ? "you" : message.role === "assistant" ? "agent" : "tool";
    const text = placeholder ?? message.text;
    if (text || message.thinking) {
      items.push({
        kind: "message",
        key: message.key,
        author,
        text,
        thinking: message.thinking,
        entryId: message.entryId,
      });
    }
    // The owner moves from the message key to the entry id when Pi writes the entry: the row remounts once, before any result exists.
    const owner = message.entryId ?? message.key;
    const seen = new Map<string, number>();
    for (const call of message.toolCalls) {
      const occurrence = seen.get(call.id) ?? 0;
      seen.set(call.id, occurrence + 1);
      const item = toolItem(owner, call, occurrence);
      open.push({ index: items.length, at, item });
      items.push(item);
    }
    if (message.error !== null) {
      items.push({
        kind: "failure",
        key: `${message.key}:failure`,
        text: message.error || translate("error.internal"),
      });
    }
  });
  // M2-RT-11: the live status belongs to the newest call of an id that has no result; older ones only wait.
  const newest = new Map<string, OpenCall>();
  for (const call of open) newest.set(call.item.toolCallId, call);
  for (const call of newest.values())
    items[call.index] = withLive(call.item, view.tools.get(call.item.toolCallId));
  const blocks = view.partial?.blocks ?? [];
  const join = (type: string) =>
    blocks
      .filter((block) => block.type === type)
      .map((block) => block.text)
      .join("");
  const text = join("text");
  const thinking = join("thinking");
  if (text || thinking) items.push({ kind: "partial", key: "partial", text, thinking });
  return uniqueKeys(items);
}
