import { INBOX_KINDS, type InboxItem } from "@pap/contracts";
import { formatCost, type ChipTone } from "@pap/ui";
import { t, type MessageKey } from "../../i18n/index.ts";
import { visibleName } from "../../lib/visible-name.ts";

export type InboxFilter = "all" | "handle" | "replies" | "tasks";
export const FILTERS: readonly InboxFilter[] = ["all", "handle", "replies", "tasks"];

/** A question the owner has not answered yet: what the badge counts and the attention tint marks. */
export const isOpen = (item: InboxItem): boolean => item.toHandle && item.resolvedAt === null;

const isTask = (item: InboxItem): boolean => item.kind.startsWith("task_");
const isReply = (item: InboxItem): boolean => (INBOX_KINDS.replies as readonly string[]).includes(item.kind);

/** An item an agent raised (M11R91); a kind this build does not know is still drawn as an agent row. */
export const isAgentItem = (item: InboxItem): boolean => item.agentId !== null;

/** Rows to handle first, then newest first; the id breaks a tie so the order never flickers. */
export function ordered(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort(
    (a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
  );
}

export function visible(items: readonly InboxItem[], filter: InboxFilter): InboxItem[] {
  const only = { all: null, handle: isOpen, replies: isReply, tasks: isTask }[filter];
  return ordered(only === null ? items : items.filter(only));
}

/** The line's title: the trigger's name, then what happened. A question has three endings (answered, denied at its timeout, closed with its task). */
export function titleOf(item: InboxItem): string {
  const name = visibleName(item.triggerName);
  const key = ((): MessageKey => {
    switch (item.kind) {
      case "task_needs_input":
        if (item.resolvedAt === null) return "inbox.title.needsInput";
        return item.resolution === "answered"
          ? "inbox.title.answered"
          : item.resolution === "timed_out"
            ? "inbox.title.refused"
            : "inbox.title.closed";
      case "task_done":
        return "inbox.title.done";
      case "task_failed":
        return "inbox.title.failed";
      case "task_interrupted":
        return "inbox.title.interrupted";
      case "task_limited":
        return "inbox.title.limited";
      default:
        return "inbox.title.other";
    }
  })();
  return t(key, { name });
}

const KINDS: Readonly<Record<string, { readonly tone: ChipTone; readonly label: MessageKey }>> = {
  task_needs_input: { tone: "att", label: "inbox.kind.question" },
  task_done: { tone: "ok", label: "inbox.kind.done" },
  task_failed: { tone: "err", label: "inbox.kind.failed" },
  task_interrupted: { tone: "err", label: "inbox.kind.interrupted" },
  task_limited: { tone: "mut", label: "inbox.kind.limited" },
};

/** The kind chip; a kind this build does not know (M11's) is a neutral "Update". */
export const chipOf = (item: InboxItem): { readonly tone: ChipTone; readonly label: MessageKey } =>
  KINDS[item.kind] ?? { tone: "mut", label: "inbox.kind.other" };

/** "$0.31", or null when the daemon sent no cost. */
export const costOf = (item: InboxItem): string | null =>
  item.costUsd === null ? null : formatCost(item.costUsd);
