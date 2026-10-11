import { describe, expect, it } from "vitest";
import { toMessageView } from "./row-view.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const snap = (
  rows: Array<{ entryId: string | null; message: unknown }>,
  extra: Record<string, unknown> = {},
) => ({
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
  history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
  activity: { compacting: false, retry: null },
  leafId: null,
  name: null,
  ...extra,
});
const pi = (event: Record<string, unknown>) => ({ kind: "pi", event });
const entry = (fields: Record<string, unknown>) => ({
  kind: "entry",
  entry: { parentId: null, type: "message", ...fields },
});
const user = (timestamp: number, content = "hi") => ({ role: "user", content, timestamp });
const idsOf = (view: { messages: ReadonlyArray<{ entryId: string | null }> }) =>
  view.messages.map((message) => message.entryId);

describe("the snapshot", () => {
  it("keeps where the history goes on above it and the leaf", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snap([{ entryId: "e5", message: user(1) }], {
        history: { hasMore: true, oldestEntryId: "e5", turnsBefore: 3 },
        leafId: "e5",
      }),
    );
    expect(view).toMatchObject({
      history: { hasMore: true, oldestEntryId: "e5", turnsBefore: 3 },
      leafId: "e5",
    });
    expect(EMPTY_VIEW).toMatchObject({
      history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
      leafId: null,
    });
  });
});

describe("entry events bind the id Pi gave a message", () => {
  it("binds the newest unbound message of that role and time, and moves the leaf", () => {
    let view = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: user(5, "one") }));
    view = reduceSession(view, pi({ type: "message_end", message: user(5, "two") }));
    view = reduceSession(view, entry({ id: "e1", role: "user", messageTimestamp: 5 }));
    expect(idsOf(view)).toEqual([null, "e1"]);
    expect(view.leafId).toBe("e1");
    view = reduceSession(view, entry({ id: "e2", parentId: "e1", role: "user", messageTimestamp: 5 }));
    expect(idsOf(view)).toEqual(["e2", "e1"]);
    expect(view.leafId).toBe("e2");
  });

  it("binds a tool result by its call id", () => {
    const result = (id: string) => ({ role: "toolResult", toolCallId: id, content: [], timestamp: 7 });
    let view = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: result("a") }));
    view = reduceSession(view, pi({ type: "message_end", message: result("b") }));
    view = reduceSession(view, entry({ id: "t1", role: "toolResult", toolCallId: "a" }));
    expect(idsOf(view)).toEqual(["t1", null]);
  });

  it("leaves messages alone when nothing matches, but still moves the leaf", () => {
    let view = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: user(5) }));
    view = reduceSession(view, entry({ id: "m1", type: "model_change" }));
    view = reduceSession(view, entry({ id: "e9", role: "assistant", messageTimestamp: 5 }));
    expect(idsOf(view)).toEqual([null]);
    expect(view.leafId).toBe("e9");
  });

  it("does not rebind a message that has its id from the snapshot", () => {
    let view = reduceSession(EMPTY_VIEW, snap([{ entryId: "e1", message: user(5) }]));
    view = reduceSession(view, entry({ id: "e2", role: "user", messageTimestamp: 5 }));
    expect(idsOf(view)).toEqual(["e1"]);
  });

  it("ignores an entry event the contract does not accept", () => {
    const view = reduceSession(EMPTY_VIEW, pi({ type: "message_end", message: user(5) }));
    expect(
      reduceSession(view, { kind: "entry", entry: { id: "x".repeat(129), parentId: null, type: "message" } }),
    ).toBe(view);
  });
});

describe("row events", () => {
  const summary = { role: "compactionSummary", summary: "S", tokensBefore: 90, timestamp: 8 };

  it("appends a summary row with its id, once", () => {
    let view = reduceSession(EMPTY_VIEW, snap([{ entryId: "e1", message: user(1) }]));
    view = reduceSession(view, { kind: "row", row: { entryId: "c1", message: summary } });
    view = reduceSession(view, { kind: "row", row: { entryId: "c1", message: summary } });
    expect(view.messages).toHaveLength(2);
    expect(view.messages[1]).toMatchObject({
      entryId: "c1",
      role: "compactionSummary",
      text: "S",
      tokensBefore: 90,
    });
  });

  it("shows a summary read from the snapshot like the same summary seen live", () => {
    const fromSnapshot = reduceSession(EMPTY_VIEW, snap([{ entryId: "c1", message: summary }]));
    const live = reduceSession(EMPTY_VIEW, { kind: "row", row: { entryId: "c1", message: summary } });
    expect(live.messages).toEqual(fromSnapshot.messages);
  });
});

describe("summary and custom messages", () => {
  it("shows a branch summary and a visible custom message as text", () => {
    expect(toMessageView({ role: "branchSummary", summary: "B", fromId: "e1", timestamp: 3 })).toMatchObject({
      role: "branchSummary",
      text: "B",
      tokensBefore: null,
    });
    expect(
      toMessageView({
        role: "custom",
        customType: "x",
        display: true,
        content: [{ type: "text", text: "note" }],
        timestamp: 4,
      }),
    ).toMatchObject({ role: "custom", text: "note" });
    expect(
      toMessageView({ role: "custom", customType: "x", display: true, content: "plain", timestamp: 4 }),
    ).toMatchObject({
      text: "plain",
    });
  });

  it("hides a custom message whose display is false, in a snapshot and live", () => {
    const hidden = { role: "custom", customType: "x", display: false, content: "secret", timestamp: 4 };
    expect(toMessageView(hidden)).toBeNull();
    const view = reduceSession(
      EMPTY_VIEW,
      snap([
        { entryId: "k1", message: hidden },
        { entryId: "e1", message: user(1) },
      ]),
    );
    expect(view.messages.map((message) => message.role)).toEqual(["user"]);
    expect(reduceSession(view, pi({ type: "message_end", message: hidden }))).toMatchObject({
      messages: view.messages,
    });
  });
});
