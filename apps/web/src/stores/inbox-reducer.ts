import { INBOX_LIMITS, type InboxItem, InboxStreamEvent } from "@pap/contracts";

export interface InboxView {
  readonly loaded: boolean;
  /** Open questions first, then the rest; each group newest first. */
  readonly items: readonly InboxItem[];
  /** Unread items: the count the daemon keeps, not the length of `items`. */
  readonly unread: number;
  /** Questions not resolved yet: what the badge shows. */
  readonly toHandle: number;
  readonly truncated: boolean;
  /** Events this build could not read: skipped, never fatal. */
  readonly skipped: number;
}

export const EMPTY_INBOX: InboxView = {
  loaded: false,
  items: [],
  unread: 0,
  toHandle: 0,
  truncated: false,
  skipped: 0,
};

const open = (item: InboxItem): boolean => item.toHandle && item.resolvedAt === null;
const order = (a: InboxItem, b: InboxItem) =>
  Number(open(b)) - Number(open(a)) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

/** Every open question stays; past the cap the oldest of the others go first. */
function bounded(items: Map<string, InboxItem>): InboxItem[] {
  const list = [...items.values()].sort(order);
  const others = list.filter((item) => !open(item));
  const drop = new Set(others.slice(INBOX_LIMITS.clientOthers).map((item) => item.id));
  return drop.size === 0 ? list : list.filter((item) => !drop.has(item.id));
}

export function reduceInbox(view: InboxView, event: unknown): InboxView {
  const parsed = InboxStreamEvent.safeParse(event);
  if (!parsed.success) return { ...view, skipped: view.skipped + 1 };
  const next = parsed.data;
  switch (next.kind) {
    case "snapshot":
      return {
        loaded: true,
        items: bounded(new Map(next.items.map((item) => [item.id, item]))),
        unread: next.unread,
        toHandle: next.toHandle,
        truncated: next.truncated,
        skipped: view.skipped,
      };
    case "item": {
      const items = new Map(view.items.map((item) => [item.id, item]));
      items.set(next.item.id, next.item);
      return { ...view, items: bounded(items) };
    }
    case "counts":
      return { ...view, unread: next.unread, toHandle: next.toHandle };
  }
}
