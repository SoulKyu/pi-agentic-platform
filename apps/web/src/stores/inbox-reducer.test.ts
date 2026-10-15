import { INBOX_LIMITS, type InboxItem } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { EMPTY_INBOX, reduceInbox } from "./inbox-reducer.ts";

const item = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({
  id,
  kind: "task_done",
  toHandle: false,
  taskId: id,
  sessionId: `s-${id}`,
  triggerName: "prod-alerts",
  costUsd: null,
  createdAt: 100,
  readAt: null,
  resolvedAt: null,
  resolution: null,
  ...patch,
});
const question = (id: string, patch: Partial<InboxItem> = {}) =>
  item(id, { kind: "task_needs_input", toHandle: true, ...patch });
const snapshot = (items: InboxItem[], unread = items.length, toHandle = 0) => ({
  kind: "snapshot",
  items,
  unread,
  toHandle,
  truncated: false,
});
const ids = (view: { items: readonly InboxItem[] }) => view.items.map((one) => one.id);

describe("the inbox reducer", () => {
  it("starts empty and not loaded", () => {
    expect(EMPTY_INBOX).toMatchObject({ loaded: false, items: [], unread: 0, toHandle: 0 });
  });

  it("takes a snapshot: the items, the counts and the loaded flag", () => {
    const view = reduceInbox(EMPTY_INBOX, snapshot([item("a")], 1, 0));
    expect(view).toMatchObject({ loaded: true, unread: 1, toHandle: 0 });
    expect(ids(view)).toEqual(["a"]);
  });

  it("takes the counts of a counts event", () => {
    const view = reduceInbox(reduceInbox(EMPTY_INBOX, snapshot([])), {
      kind: "counts",
      unread: 4,
      toHandle: 2,
    });
    expect(view).toMatchObject({ unread: 4, toHandle: 2 });
  });

  it("upserts an item by id", () => {
    const first = reduceInbox(EMPTY_INBOX, snapshot([item("a")]));
    const next = reduceInbox(first, { kind: "item", item: item("a", { readAt: 500 }) });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.readAt).toBe(500);
  });

  it("orders open questions first, then the rest, newest first", () => {
    let view = reduceInbox(
      EMPTY_INBOX,
      snapshot([
        item("old", { createdAt: 1 }),
        item("new", { createdAt: 9 }),
        question("q", { createdAt: 5 }),
      ]),
    );
    expect(ids(view)).toEqual(["q", "new", "old"]);
    view = reduceInbox(view, {
      kind: "item",
      item: question("q", { createdAt: 5, resolvedAt: 6, resolution: "answered" }),
    });
    expect(ids(view)).toEqual(["new", "q", "old"]);
  });

  it("moves a reopened question back to the top", () => {
    let view = reduceInbox(
      EMPTY_INBOX,
      snapshot([
        question("q", { createdAt: 5, resolvedAt: 6, resolution: "answered" }),
        item("new", { createdAt: 9 }),
      ]),
    );
    expect(ids(view)).toEqual(["new", "q"]);
    view = reduceInbox(view, { kind: "item", item: question("q", { createdAt: 12 }) });
    expect(ids(view)).toEqual(["q", "new"]);
    expect(view.items[0]).toMatchObject({ resolvedAt: null, resolution: null });
  });

  it("keeps every open question and bounds the others, the oldest going first", () => {
    const others = Array.from({ length: INBOX_LIMITS.clientOthers + 5 }, (_, index) =>
      item(`o${index}`, { createdAt: 1000 + index }),
    );
    const view = reduceInbox(EMPTY_INBOX, snapshot([question("q", { createdAt: 1 }), ...others]));
    expect(view.items).toHaveLength(INBOX_LIMITS.clientOthers + 1);
    expect(ids(view)[0]).toBe("q");
    expect(ids(view)).not.toContain("o0");
  });

  it("counts an event it cannot read and keeps the view", () => {
    const first = reduceInbox(EMPTY_INBOX, snapshot([item("a")]));
    const next = reduceInbox(first, { kind: "item", item: { id: 1 } });
    expect(next.skipped).toBe(1);
    expect(ids(next)).toEqual(["a"]);
  });
});
