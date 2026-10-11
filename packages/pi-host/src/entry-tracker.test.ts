import { describe, expect, it } from "vitest";
import {
  createEntryTracker,
  MAX_FLUSH_ENTRIES,
  MAX_KNOWN_ENTRIES,
  MAX_WALK_ENTRIES,
} from "./entry-tracker.ts";

type Entry = { id: string; parentId: string | null; type: string; timestamp: string; message?: object };

// A session tree in memory: `append` moves the leaf like Pi's SessionManager does, `moveTo` is what navigation does.
function tree() {
  const entries = new Map<string, Entry>();
  let leaf: string | null = null;
  let counter = 0;
  return {
    manager: {
      getLeafId: () => leaf,
      getEntry: (id: string) => entries.get(id),
    },
    append(role = "user", id = `e${++counter}`): string {
      entries.set(id, {
        id,
        parentId: leaf,
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role, timestamp: 10 + entries.size },
      });
      leaf = id;
      return id;
    },
    moveTo(id: string | null) {
      leaf = id;
    },
  };
}

function bed(initial: (t: ReturnType<typeof tree>) => void = () => {}) {
  const t = tree();
  initial(t);
  const sent: Array<Record<string, unknown>> = [];
  const errors: unknown[] = [];
  const deferred: Array<() => void> = [];
  const tracker = createEntryTracker({
    manager: t.manager,
    send: (record) => void sent.push(record),
    defer: (task) => void deferred.push(task),
    onError: (error) => void errors.push(error),
  });
  const run = () => deferred.splice(0).forEach((task) => task());
  const runAll = () => {
    let rounds = 0;
    while (deferred.length > 0) {
      run();
      rounds++;
    }
    return rounds;
  };
  const ids = () =>
    sent.flatMap((r) => (r.type === "entry_appended" ? [(r.entry as { id: string }).id] : []));
  return { t, tracker, sent, errors, deferred, run, runAll, ids };
}

describe("entry tracker", () => {
  it("waits for the next macrotask, then sends the entries since the leaf it knew, oldest first and slim", () => {
    const { t, tracker, sent, deferred, run } = bed((x) => x.append("user", "start"));
    t.append("user", "u1");
    t.append("assistant", "a1");
    tracker.observe({ type: "message_end" });
    expect(sent).toEqual([]);
    expect(deferred).toHaveLength(1);
    run();
    expect(sent).toEqual([
      {
        type: "entry_appended",
        entry: {
          id: "u1",
          parentId: "start",
          type: "message",
          timestamp: "2026-01-01T00:00:00.000Z",
          role: "user",
          messageTimestamp: 11,
        },
      },
      {
        type: "entry_appended",
        entry: {
          id: "a1",
          parentId: "u1",
          type: "message",
          timestamp: "2026-01-01T00:00:00.000Z",
          role: "assistant",
          messageTimestamp: 12,
        },
      },
    ]);
  });

  it("sends nothing when the leaf has not moved, and sends each entry once", () => {
    const { t, tracker, sent, run, ids } = bed((x) => x.append("user", "start"));
    tracker.observe({ type: "turn_end" });
    run();
    expect(sent).toEqual([]);
    t.append("user", "u1");
    tracker.observe({ type: "message_end" });
    run();
    tracker.observe({ type: "agent_end" });
    run();
    expect(ids()).toEqual(["u1"]);
  });

  it("does only one flush for a burst of events", () => {
    const { t, tracker, deferred, run, ids } = bed((x) => x.append("user", "start"));
    t.append("user", "u1");
    for (const type of ["message_end", "turn_end", "agent_end", "compaction_end", "agent_settled"]) {
      tracker.observe({ type });
    }
    expect(deferred).toHaveLength(1);
    run();
    expect(ids()).toEqual(["u1"]);
  });

  it("ignores events that cannot append an entry", () => {
    const { t, tracker, deferred } = bed((x) => x.append("user", "start"));
    t.append("user", "u1");
    for (const type of ["message_update", "tool_execution_end", "agent_start", "queue_update"]) {
      tracker.observe({ type });
    }
    expect(deferred).toEqual([]);
  });

  it("does not send an entry Pi announced itself, but still sends the ones around it and the real leaf", () => {
    const { t, tracker, sent, run, ids } = bed((x) => x.append("user", "start"));
    t.append("user", "u1");
    t.append("assistant", "warm");
    tracker.observe({ type: "entry_appended", entry: { id: "warm" } });
    t.append("assistant", "a1");
    tracker.observe({ type: "message_end" });
    run();
    expect(ids()).toEqual(["u1", "a1"]);
    expect(sent.at(-1)).toMatchObject({ type: "entry_appended", entry: { id: "a1" } });

    // Pi's own entry is the newest: the leaf is not the last entry sent, so the daemon is told the leaf.
    t.append("assistant", "warm2");
    tracker.observe({ type: "entry_appended", entry: { id: "warm2" } });
    run();
    expect(sent.at(-1)).toEqual({ type: "leaf", leafId: "warm2", resync: false });
  });

  it("tells the daemon the leaf when it moved to another branch, without sending entries that are not new", () => {
    const { t, tracker, sent, run, ids } = bed((x) => x.append("user", "start"));
    t.append("user", "u1");
    t.append("assistant", "a1");
    tracker.observe({ type: "message_end" });
    run();
    sent.length = 0;
    t.moveTo("start");
    tracker.leafMayHaveMoved();
    run();
    expect(sent).toEqual([{ type: "leaf", leafId: "start", resync: false }]);
    t.append("user", "u2");
    tracker.observe({ type: "message_end" });
    run();
    expect(ids()).toEqual(["u2"]);
  });

  it("sends a burst in batches of the bound, one batch per macrotask, in order, without a resync", () => {
    const { t, tracker, sent, deferred, run, ids } = bed((x) => x.append("user", "start"));
    for (let i = 0; i < 300; i++) t.append("custom", `n${i}`);
    tracker.observe({ type: "entry_appended", entry: { id: "x" } });
    const sizes: number[] = [];
    while (deferred.length > 0) {
      const before = sent.length;
      expect(deferred).toHaveLength(1);
      run();
      sizes.push(sent.length - before);
    }
    expect(sizes).toEqual([MAX_FLUSH_ENTRIES, MAX_FLUSH_ENTRIES, 300 - 2 * MAX_FLUSH_ENTRIES]);
    expect(ids()).toEqual(Array.from({ length: 300 }, (_, i) => `n${i}`));
    expect(sent.some((record) => record.type === "leaf")).toBe(false);
  });

  it("sends an entry appended between two batches after the burst, once, in order", () => {
    const { t, tracker, runAll, run, ids } = bed((x) => x.append("user", "start"));
    for (let i = 0; i < 300; i++) t.append("custom", `n${i}`);
    tracker.observe({ type: "entry_appended", entry: { id: "x" } });
    run();
    t.append("assistant", "late");
    tracker.observe({ type: "message_end" });
    runAll();
    expect(ids()).toEqual([...Array.from({ length: 300 }, (_, i) => `n${i}`), "late"]);
  });

  it("walks again for a leaf that moved while a burst was being sent", () => {
    const { t, tracker, sent, runAll, run } = bed((x) => x.append("user", "start"));
    for (let i = 0; i < 200; i++) t.append("custom", `n${i}`);
    tracker.observe({ type: "entry_appended", entry: { id: "x" } });
    run();
    t.moveTo("start");
    tracker.leafMayHaveMoved();
    runAll();
    expect(sent.at(-1)).toEqual({ type: "leaf", leafId: "start", resync: false });
  });

  it("keeps skipping announced entries across batches and ends with the leaf record when the leaf was announced", () => {
    const { t, tracker, sent, runAll, ids } = bed((x) => x.append("user", "start"));
    for (let i = 0; i < 200; i++) t.append("custom", `n${i}`);
    tracker.observe({ type: "entry_appended", entry: { id: "n199" } });
    tracker.observe({ type: "entry_appended", entry: { id: "n3" } });
    runAll();
    expect(ids()).toEqual(
      Array.from({ length: 200 }, (_, i) => `n${i}`).filter((id) => id !== "n3" && id !== "n199"),
    );
    expect(sent.at(-1)).toEqual({ type: "leaf", leafId: "n199", resync: false });
    t.append("user", "after");
    tracker.observe({ type: "message_end" });
    runAll();
    expect(ids().at(-1)).toBe("after");
  });

  it("sends one resync record, not the entries, when the walk passes its cap", () => {
    const { t, tracker, sent, runAll, ids } = bed((x) => x.append("user", "start"));
    for (let i = 0; i < MAX_WALK_ENTRIES + 1; i++) t.append("custom", `n${i}`);
    tracker.observe({ type: "entry_appended", entry: { id: "x" } });
    runAll();
    expect(sent).toEqual([{ type: "leaf", leafId: `n${MAX_WALK_ENTRIES}`, resync: true }]);
    t.append("user", "after");
    tracker.observe({ type: "message_end" });
    runAll();
    expect(ids()).toEqual(["after"]);
  });

  it("sends exactly the walk cap when that many are new", () => {
    const { t, tracker, runAll, ids } = bed((x) => x.append("user", "start"));
    for (let i = 0; i < MAX_WALK_ENTRIES; i++) t.append("custom", `n${i}`);
    tracker.observe({ type: "message_end" });
    runAll();
    expect(ids()).toHaveLength(MAX_WALK_ENTRIES);
  });

  it("sends exactly the bound when that many are new", () => {
    const { t, tracker, run, ids } = bed((x) => x.append("user", "start"));
    for (let i = 0; i < MAX_FLUSH_ENTRIES; i++) t.append("custom", `n${i}`);
    tracker.observe({ type: "message_end" });
    run();
    expect(ids()).toHaveLength(MAX_FLUSH_ENTRIES);
    expect(ids()[0]).toBe("n0");
  });

  it("forgets the oldest announced ids beyond its bound", () => {
    const { t, tracker, run, ids } = bed((x) => x.append("user", "start"));
    t.append("custom", "old");
    tracker.observe({ type: "entry_appended", entry: { id: "old" } });
    for (let i = 0; i < MAX_KNOWN_ENTRIES; i++)
      tracker.observe({ type: "entry_appended", entry: { id: `z${i}` } });
    run();
    expect(ids()).toEqual(["old"]);
  });

  it("says a failure and keeps working", () => {
    const { t, tracker, errors, run, ids } = bed((x) => x.append("user", "start"));
    const getEntry = t.manager.getEntry;
    t.manager.getEntry = () => {
      throw new Error("broken tree");
    };
    t.append("user", "u1");
    tracker.observe({ type: "message_end" });
    run();
    expect(errors).toHaveLength(1);
    t.manager.getEntry = getEntry;
    tracker.observe({ type: "message_end" });
    run();
    expect(ids()).toEqual(["u1"]);
  });

  it("ignores an event that is not an object with a string type", () => {
    const { tracker, deferred } = bed();
    tracker.observe(null as never);
    tracker.observe({ type: 3 } as never);
    expect(deferred).toEqual([]);
  });
});
