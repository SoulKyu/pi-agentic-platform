import { describe, expect, it } from "vitest";
import { prependHistory } from "./history.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";
import { useSessionStore } from "./session-store.ts";

const row = (entryId: string, content: string) => ({
  entryId,
  message: { role: "user", content, timestamp: Number(entryId.slice(1)) },
});

const snapshotOf = (rows: ReturnType<typeof row>[], oldestEntryId: string) => ({
  kind: "snapshot",
  status: "idle",
  rows,
  dialogs: [],
  partial: null,
  queue: { steering: [], followUp: [], count: 0, bytes: 0 },
  statuses: [],
  widgets: [],
  title: null,
  panels: [],
  notices: [],
  decorationsTruncated: false,
  history: { hasMore: true, oldestEntryId, turnsBefore: 2 },
  activity: { compacting: false, retry: null },
  leafId: "e4",
  name: null,
});
const older = {
  rows: [row("e1", "a"), row("e2", "b"), row("e3", "c")],
  hasMore: false,
  oldestEntryId: "e1",
  turnsBefore: 0,
};

describe("prependHistory", () => {
  it("puts an older page before the rows, once, and moves the cursor", () => {
    const view = reduceSession(EMPTY_VIEW, snapshotOf([row("e3", "c"), row("e4", "d")], "e3"));
    const next = prependHistory(view, older, { generation: view.generation, oldestEntryId: "e3" });
    expect(next.messages.map((message) => message.entryId)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(next.history).toEqual({ hasMore: false, oldestEntryId: "e1", turnsBefore: 0 });
  });

  it("drops a page asked for a view that a snapshot replaced meanwhile (M2-RT-12)", () => {
    const first = reduceSession(EMPTY_VIEW, snapshotOf([row("e3", "c"), row("e4", "d")], "e3"));
    const asked = { generation: first.generation, oldestEntryId: "e3" };
    // "Edit from here" or the branch switcher: a new snapshot of another branch arrives before the page.
    const replaced = reduceSession(first, snapshotOf([row("e3", "c"), row("e9", "other branch")], "e3"));
    expect(prependHistory(replaced, older, asked)).toBe(replaced);
  });

  it("drops a page whose cursor another page already moved", () => {
    const view = reduceSession(EMPTY_VIEW, snapshotOf([row("e3", "c"), row("e4", "d")], "e3"));
    const asked = { generation: view.generation, oldestEntryId: "e3" };
    const moved = prependHistory(view, older, asked);
    expect(prependHistory(moved, older, asked)).toBe(moved);
  });

  it("keeps every key unique when an older page repeats a message's name", () => {
    const view = reduceSession(EMPTY_VIEW, snapshotOf([row("e3", "c"), row("e4", "d")], "e3"));
    const same = {
      ...older,
      rows: [{ entryId: "e2", message: { role: "user", content: "b", timestamp: 3 } }],
    };
    const next = prependHistory(view, same, { generation: view.generation, oldestEntryId: "e3" });
    expect(new Set(next.messages.map((message) => message.key)).size).toBe(3);
  });
});

describe("the store's prependHistory", () => {
  it("applies a page to the view it was asked for, and leaves an unknown session alone", () => {
    const store = useSessionStore.getState();
    store.apply("s1", snapshotOf([row("e3", "c"), row("e4", "d")], "e3"));
    const view = useSessionStore.getState().views.s1;
    const asked = { generation: view?.generation ?? -1, oldestEntryId: "e3" };
    store.prependHistory("ghost", older, asked);
    expect(useSessionStore.getState().views.ghost).toBeUndefined();
    store.prependHistory("s1", older, asked);
    expect(useSessionStore.getState().views.s1?.messages.map((message) => message.entryId)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    const after = useSessionStore.getState().views.s1;
    store.prependHistory("s1", older, asked);
    expect(useSessionStore.getState().views.s1).toBe(after);
  });
});
