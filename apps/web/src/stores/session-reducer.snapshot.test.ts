import { describe, expect, it } from "vitest";
import { sessionSnapshot } from "../testing/session-snapshot.ts";
import { keyMessages, toMessageView, type MessageView } from "./row-view.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const snapshot = (rows: Array<{ entryId: string | null; message: unknown }>) => ({
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
});
const live = (message: Record<string, unknown>) => ({ kind: "pi", event: { type: "message_end", message } });

/** A map that counts every lookup and write it serves. */
class CountingMap<K, V> extends Map<K, V> {
  operations = 0;
  override has(key: K): boolean {
    this.operations++;
    return super.has(key);
  }
  override get(key: K): V | undefined {
    this.operations++;
    return super.get(key);
  }
  override set(key: K, value: V): this {
    this.operations++;
    return super.set(key, value);
  }
}

const views = (count: number, distinct: boolean): MessageView[] =>
  Array.from({ length: count }, (_, i) => {
    const view = toMessageView({ role: "user", content: "x", timestamp: distinct ? i : 1 });
    if (!view) throw new Error("unreachable");
    return view;
  });

describe("keys of a long snapshot", () => {
  it.each([false, true])("cost a linear number of map operations (all alike: %s)", (alike) => {
    const taken = new CountingMap<string, number>();
    const keyed = keyMessages(views(2000, !alike), taken);
    expect(new Set(keyed.map((message) => message.key)).size).toBe(2000);
    expect(taken.operations).toBeLessThanOrEqual(2000 * 6);
  });

  it("keeps the first key of a ref as it is and numbers the later ones", () => {
    expect(keyMessages(views(3, false).map((m) => ({ ...m, ref: "user:1" }))).map((m) => m.key)).toEqual([
      "user:1",
      "user:1#1",
      "user:1#2",
    ]);
  });

  it("reduces a 2 000-message snapshot with unique keys", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      entryId: `e${i}`,
      message: { role: "user", content: "same", timestamp: 7 },
    }));
    const view = reduceSession(EMPTY_VIEW, snapshot(rows));
    expect(view.messages).toHaveLength(2000);
    expect(new Set(view.messages.map((message) => message.key)).size).toBe(2000);
  });
});

describe("live messages with no timestamp (role:none refs)", () => {
  it("keeps two different messages that have equal content", () => {
    let view = reduceSession(EMPTY_VIEW, live({ role: "user", content: "again" }));
    view = reduceSession(view, live({ role: "user", content: "again" }));
    expect(view.messages.map((message) => [message.ref, message.text])).toEqual([
      ["user:none", "again"],
      ["user:none", "again"],
    ]);
    expect(new Set(view.messages.map((message) => message.key)).size).toBe(2);
  });

  it("still drops the replay of a message that has a timestamp", () => {
    const once = reduceSession(EMPTY_VIEW, live({ role: "user", content: "hi", timestamp: 5 }));
    expect(reduceSession(once, live({ role: "user", content: "hi", timestamp: 5 })).messages).toHaveLength(1);
  });
});

describe("reduceSession, the session's folder (M4)", () => {
  it("keeps the folder from the snapshot", () => {
    expect(reduceSession(EMPTY_VIEW, sessionSnapshot({ cwd: "/w/api" })).cwd).toBe("/w/api");
  });

  it("has no folder before a snapshot", () => {
    expect(EMPTY_VIEW.cwd).toBe("");
  });

  it("reads a snapshot of an older daemon, without a folder, as empty", () => {
    const older: Record<string, unknown> = sessionSnapshot();
    delete older["cwd"];
    const view = reduceSession(EMPTY_VIEW, older);
    expect(view.unreadable).toBe(false);
    expect(view.cwd).toBe("");
  });
});

describe("reduceSession, a write outside pap (owner Q13)", () => {
  it("keeps the flag from the snapshot, false before one and from an older daemon", () => {
    expect(EMPTY_VIEW.outsideWrite).toBe(false);
    expect(reduceSession(EMPTY_VIEW, sessionSnapshot({ outsideWrite: true })).outsideWrite).toBe(true);
    const older: Record<string, unknown> = sessionSnapshot();
    delete older["outsideWrite"];
    expect(reduceSession(EMPTY_VIEW, older).outsideWrite).toBe(false);
  });
});
