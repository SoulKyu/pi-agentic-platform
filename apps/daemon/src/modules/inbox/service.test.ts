import { InboxStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DAY_MS, createInboxBed, type InboxBed } from "./testing/bed.ts";

let bed: InboxBed;
afterEach(() => bed.dispose());

const snapshot = (ownerId = "u1") => bed.inbox.snapshot(ownerId);
const counts = (ownerId = "u1") => {
  const { unread, toHandle } = snapshot(ownerId);
  return { unread, toHandle };
};

describe("a question of a running task", () => {
  it("writes one task_needs_input item, to handle", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    expect(bed.rows()).toHaveLength(1);
    expect(snapshot().items[0]).toMatchObject({
      kind: "task_needs_input",
      toHandle: true,
      taskId: "t1",
      sessionId: "s-t1",
      triggerName: "prod-alerts",
      resolvedAt: null,
      resolution: null,
    });
    expect(counts()).toEqual({ unread: 1, toHandle: 1 });
  });

  it("resolves it as answered when the answer came, and keeps the item", async () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    await bed.clock.advance(1000);
    bed.attend("t1", false);
    expect(bed.rows()).toHaveLength(1);
    expect(snapshot().items[0]).toMatchObject({ resolution: "answered", toHandle: true });
    expect(snapshot().items[0]?.resolvedAt).toBe(bed.clock.now());
    expect(counts().toHandle).toBe(0);
  });

  it("reopens the same row for a second question: still one row, counted again, unread again (RT-11)", async () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    bed.inbox.markRead("u1", { all: true });
    bed.attend("t1", false);
    await bed.clock.advance(5000);
    bed.attend("t1", true);
    expect(bed.rows()).toHaveLength(1);
    expect(snapshot().items[0]).toMatchObject({
      resolvedAt: null,
      readAt: null,
      resolution: null,
      createdAt: bed.clock.now(),
    });
    expect(counts()).toEqual({ unread: 1, toHandle: 1 });
  });

  it("does not move an open question again when the same attention arrives twice", async () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    bed.inbox.markRead("u1", { all: true });
    await bed.clock.advance(5000);
    bed.attend("t1", true);
    expect(snapshot().items[0]?.readAt).not.toBeNull();
    expect(counts()).toEqual({ unread: 0, toHandle: 1 });
  });

  it("resolves it as timed_out when nobody answered in ten minutes", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    bed.timeout("t1");
    expect(snapshot().items[0]).toMatchObject({ resolution: "timed_out" });
    expect(counts().toHandle).toBe(0);
  });

  it("closes a question the task left behind when it ends, with no resolution", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    bed.move("t1", "failed");
    expect(bed.row("t1", "task_needs_input")).toMatchObject({ resolution: null });
    expect(bed.row("t1", "task_needs_input")?.resolved_at).not.toBeNull();
    expect(counts().toHandle).toBe(0);
  });

  it("ignores a task it cannot find", () => {
    bed = createInboxBed();
    bed.attend("ghost", true);
    expect(bed.rows()).toEqual([]);
  });
});

describe("the state a task ended in", () => {
  it.each([
    ["done", "task_done"],
    ["failed", "task_failed"],
    ["interrupted", "task_interrupted"],
    ["limited", "task_limited"],
  ] as const)("writes %s as %s, an info item that needs no answer", (state, kind) => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.move("t1", state, "running", 0.25);
    expect(bed.rows()).toHaveLength(1);
    expect(snapshot().items[0]).toMatchObject({ kind, toHandle: false, taskId: "t1", costUsd: 0.25 });
    expect(counts()).toEqual({ unread: 1, toHandle: 0 });
  });

  it("writes nothing for a task the owner cancelled", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.move("t1", "cancelled");
    expect(bed.rows()).toEqual([]);
  });

  it("writes nothing for the moves that are not an end", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.move("t1", "queued", null);
    bed.move("t1", "running", "queued");
    expect(bed.rows()).toEqual([]);
  });

  it("keeps one item when the same terminal transition is heard twice", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.move("t1", "done");
    bed.inbox.markRead("u1", { all: true });
    bed.move("t1", "done");
    expect(bed.rows()).toHaveLength(1);
    expect(counts().unread).toBe(0);
  });

  it("shows only the trigger name, stripped and clipped, whatever the task view carried", () => {
    bed = createInboxBed();
    bed.addTask("t1", "u1", `evil‮\nname${"x".repeat(400)}`);
    bed.move("t1", "done");
    const name = snapshot().items[0]?.triggerName as string;
    expect(name).not.toMatch(/[‮\n]/);
    expect([...name].length).toBeLessThanOrEqual(200);
  });
});

describe("who sees what", () => {
  it("never puts another owner's items in the snapshot nor in the stream", () => {
    bed = createInboxBed();
    bed.addTask("t1", "u1");
    bed.addTask("t2", "u2", "other");
    const mine = bed.open("u1");
    const theirs = bed.open("u2");
    bed.attend("t2", true);
    bed.move("t2", "done");
    expect(snapshot("u1").items).toEqual([]);
    expect(snapshot("u2").items).toHaveLength(2);
    expect(mine).toHaveLength(1);
    expect(theirs.length).toBeGreaterThan(1);
  });

  it("sends the snapshot, then an item and the counts for each change, all readable by the contract", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    const frames = bed.open("u1");
    bed.attend("t1", true);
    const sent = frames.map((frame) => InboxStreamEvent.parse(frame.event));
    expect(sent.map((event) => event.kind)).toEqual(["snapshot", "item", "counts"]);
    expect(sent[2]).toEqual({ kind: "counts", unread: 1, toHandle: 1 });
  });

  it("puts every open question and the newest 100 others in the snapshot, newest first", () => {
    bed = createInboxBed();
    bed.seed("u1", 150, { kind: "task_done", at: 1000 });
    bed.seed("u1", 3, { kind: "task_needs_input", toHandle: true, at: 10 });
    const result = snapshot();
    expect(result.items).toHaveLength(103);
    expect(result.truncated).toBe(false);
    const others = result.items.filter((item) => !item.toHandle);
    expect(others).toHaveLength(100);
    expect(others[0]?.createdAt).toBeGreaterThan(others[99]?.createdAt as number);
    expect(result.unread).toBe(153);
    expect(result.toHandle).toBe(3);
  });

  it("pages older items, 100 at a time, from a cursor, and only the owner's", () => {
    bed = createInboxBed();
    bed.seed("u1", 130, { kind: "task_done", at: 1000 });
    bed.seed("u2", 5, { kind: "task_done", at: 1000 });
    const first = bed.inbox.list("u1", undefined);
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const last = first.items[99] as { createdAt: number; id: string };
    const second = bed.inbox.list("u1", { createdAt: last.createdAt, id: last.id });
    expect(second.items).toHaveLength(30);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(130);
  });
});

describe("the cap of 2 000 items an owner (M10R49)", () => {
  it("evicts the oldest read info item for a new info item", () => {
    bed = createInboxBed();
    bed.seed("u1", 10, { kind: "task_done", read: true, at: 100 });
    bed.seed("u1", 1990, { kind: "task_done", at: 5000 });
    bed.addTask("t1");
    bed.move("t1", "done");
    const rows = bed.rows();
    expect(rows).toHaveLength(2000);
    expect(rows.some((row) => row.id === "seed-u1-task_done-r-100-0")).toBe(false);
    expect(rows.some((row) => row.id === "seed-u1-task_done-r-100-1")).toBe(true);
    expect(bed.row("t1", "task_done")).toBeDefined();
  });

  it("skips and logs a new info item when none can go, and still writes a question", () => {
    bed = createInboxBed();
    bed.seed("u1", 2000, { kind: "task_done", at: 5000 });
    bed.addTask("t1");
    bed.addTask("t2");
    bed.move("t1", "failed");
    bed.move("t2", "failed");
    expect(bed.row("t1", "task_failed")).toBeUndefined();
    expect(bed.logs.filter((line) => line.msg === "inbox_full")).toHaveLength(1);
    bed.attend("t1", true);
    expect(bed.row("t1", "task_needs_input")).toBeDefined();
    expect(bed.rows()).toHaveLength(2001);
  });

  it("never evicts an unread item nor a question, read or not", () => {
    bed = createInboxBed();
    bed.seed("u1", 1000, { kind: "task_needs_input", toHandle: true, read: true, at: 100 });
    bed.seed("u1", 1000, { kind: "task_done", at: 5000 });
    bed.addTask("t1");
    bed.move("t1", "done");
    expect(bed.rows()).toHaveLength(2000);
    expect(bed.row("t1", "task_done")).toBeUndefined();
  });

  it("counts the cap per owner", () => {
    bed = createInboxBed();
    bed.seed("u2", 2000, { kind: "task_done", at: 5000 });
    bed.addTask("t1");
    bed.move("t1", "done");
    expect(bed.row("t1", "task_done")).toBeDefined();
  });
});

describe("retention", () => {
  it("removes only read items, resolved, older than 30 days", () => {
    bed = createInboxBed();
    const now = bed.clock.now();
    const old = now - 31 * DAY_MS;
    const seed = (
      id: string,
      row: { toHandle: number; createdAt: number; readAt: number | null; resolvedAt?: number },
    ) =>
      bed.db.run(
        `INSERT INTO inbox_items (id, owner_id, kind, to_handle, title, created_at, read_at, resolved_at)
         VALUES ($id, 'u1', 'k', $toHandle, 't', $createdAt, $readAt, $resolvedAt)`,
        {
          id,
          toHandle: row.toHandle,
          createdAt: row.createdAt,
          readAt: row.readAt,
          resolvedAt: row.resolvedAt ?? null,
        },
      );
    seed("old-read-info", { toHandle: 0, createdAt: old, readAt: old });
    seed("old-unread-info", { toHandle: 0, createdAt: old, readAt: null });
    seed("old-read-open-question", { toHandle: 1, createdAt: old, readAt: old });
    seed("old-read-answered", { toHandle: 1, createdAt: old, readAt: old, resolvedAt: old });
    seed("recent-read-info", { toHandle: 0, createdAt: now - 29 * DAY_MS, readAt: now });
    bed.inbox.retention();
    expect(
      bed
        .rows()
        .map((row) => row.id)
        .sort(),
    ).toEqual(["old-read-open-question", "old-unread-info", "recent-read-info"]);
  });
});

describe("read-only mode", () => {
  it("listens to nothing", () => {
    bed = createInboxBed({ readOnly: true });
    bed.addTask("t1");
    bed.attend("t1", true);
    bed.move("t1", "done");
    expect(bed.rows()).toEqual([]);
  });
});
