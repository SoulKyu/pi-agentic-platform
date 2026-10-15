import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import {
  cancelEffect,
  cancelRequested,
  claimEffect,
  DEADLINE_MS,
  dismissFailure,
  enqueueEffect,
  LEASE_SLACK_MS,
  listFailures,
  markSent,
  nextDue,
  purgeOutbox,
  settleEffect,
} from "./store.ts";

let bed: OutboxBed;
beforeEach(() => {
  bed = openOutboxBed();
});
afterEach(() => bed.close());

const DAY = 86_400_000;
const NONE = new Set<string>();
const NO_IDS = new Set<number>();
const now = () => bed.clock.now();
const row = (id: number) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM outbox WHERE id = $id", { id });
const feedPoll = (
  triggerId: string,
  extra: { ownerId?: string | null; dedupKey?: string; at?: number } = {},
) =>
  enqueueEffect(
    bed.db,
    { kind: "feed.poll", ownerId: extra.ownerId ?? "u1", payload: { triggerId }, ...extra },
    now(),
  ) as number;
const lease = (id: number) => expect(claimEffect(bed.db, id, "feed.poll", now())).toBe(true);

describe("the outbox table", () => {
  const insert = (set: string, values: string) =>
    bed.db.run(
      `INSERT INTO outbox (kind, replay, payload, status, next_at, created_at${set}) VALUES ('k', 'replay-safe', '{}', 'pending', 0, 0${values})`,
    );
  const insertWith = (columns: string, values: string) =>
    bed.db.run(`INSERT INTO outbox (${columns}) VALUES (${values})`);

  it("accepts a plain pending row", () => {
    expect(insert("", "").changes).toBe(1);
  });

  it.each([
    [
      "a leased row without lease_until",
      "kind, replay, payload, status, next_at, created_at",
      "'k', 'replay-safe', '{}', 'leased', 0, 0",
    ],
    [
      "an unknown class",
      "kind, replay, payload, status, next_at, created_at",
      "'k', 'sometimes', '{}', 'pending', 0, 0",
    ],
    [
      "a payload that is not JSON",
      "kind, replay, payload, status, next_at, created_at",
      "'k', 'replay-safe', 'nope', 'pending', 0, 0",
    ],
    [
      "settled_at on a pending row",
      "kind, replay, payload, status, next_at, created_at, settled_at",
      "'k', 'replay-safe', '{}', 'pending', 0, 0, 1",
    ],
    [
      "sent_at on a pending row",
      "kind, replay, payload, status, next_at, created_at, sent_at",
      "'k', 'replay-safe', '{}', 'pending', 0, 0, 1",
    ],
    [
      "cancel_requested 2",
      "kind, replay, payload, status, next_at, created_at, cancel_requested",
      "'k', 'replay-safe', '{}', 'pending', 0, 0, 2",
    ],
  ])("refuses %s", (_name, columns, values) => {
    expect(() => insertWith(columns, values)).toThrow(/CHECK constraint/);
  });

  it("refuses a payload over 16 KiB", () => {
    const big = JSON.stringify({ a: "x".repeat(16_400) });
    expect(() =>
      bed.db.run(
        "INSERT INTO outbox (kind, replay, payload, status, next_at, created_at) VALUES ('k', 'replay-safe', $p, 'pending', 0, 0)",
        { p: big },
      ),
    ).toThrow(/CHECK constraint/);
  });
});

describe("enqueueEffect", () => {
  it("stores the class from the code, the owner and the payload", () => {
    const id = enqueueEffect(
      bed.db,
      { kind: "task.start", ownerId: "u1", payload: { taskId: "t1" } },
      now(),
    ) as number;
    expect(row(id)).toMatchObject({
      kind: "task.start",
      replay: "process-bound",
      owner_id: "u1",
      payload: '{"taskId":"t1"}',
      status: "pending",
      attempts: 0,
      next_at: now(),
    });
  });

  it("refuses an extra payload key", () => {
    expect(() =>
      enqueueEffect(
        bed.db,
        { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "t", extra: 1 } as never },
        now(),
      ),
    ).toThrow();
    expect(bed.db.get("SELECT 1 AS x FROM outbox")).toBeUndefined();
  });

  it("refuses an unknown kind, run.abort included", () => {
    expect(() =>
      enqueueEffect(bed.db, { kind: "run.abort" as never, ownerId: "u1", payload: {} as never }, now()),
    ).toThrow();
  });

  it("answers null for a duplicate dedupKey and writes nothing", () => {
    expect(feedPoll("t1", { dedupKey: "k1" })).toBeGreaterThan(0);
    expect(
      enqueueEffect(
        bed.db,
        { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "t2" }, dedupKey: "k1" },
        now(),
      ),
    ).toBeNull();
    expect(bed.db.all("SELECT id FROM outbox")).toHaveLength(1);
  });

  it("never schedules before now, and keeps a later time", () => {
    const early = feedPoll("a", { at: now() - 5_000 });
    const late = feedPoll("b", { at: now() + 5_000 });
    expect(row(early)?.next_at).toBe(now());
    expect(row(late)?.next_at).toBe(now() + 5_000);
  });

  it("joins the caller's transaction: a rollback leaves no effect", () => {
    expect(() =>
      bed.db.transaction(() => {
        feedPoll("t1");
        throw new Error("state change failed");
      }),
    ).toThrow("state change failed");
    expect(bed.db.all("SELECT id FROM outbox")).toHaveLength(0);
  });
});

describe("nextDue", () => {
  it("skips rows not due, rows in flight and busy kinds", () => {
    const later = feedPoll("later", { at: now() + 1_000 });
    const flying = feedPoll("flying");
    const busy = enqueueEffect(
      bed.db,
      { kind: "task.start", ownerId: "u1", payload: { taskId: "t" } },
      now(),
    ) as number;
    const ready = enqueueEffect(
      bed.db,
      { kind: "run.resume", ownerId: "u1", payload: { sessionId: "s", runId: "r", resetAt: 1 } },
      now(),
    ) as number;
    const kinds = ["feed.poll", "task.start", "run.resume"];
    expect(nextDue(bed.db, now(), kinds, new Set(["task.start"]), new Set([flying]))?.id).toBe(ready);
    expect(nextDue(bed.db, now(), kinds, NONE, new Set([flying, busy, ready]))).toBeNull();
    expect(nextDue(bed.db, now() + 1_000, ["feed.poll"], NONE, new Set([flying]))?.id).toBe(later);
  });

  it("does not let 40 due rows of an unknown kind hide a known one", () => {
    for (let i = 0; i < 40; i++)
      bed.db.run(
        "INSERT INTO outbox (kind, replay, payload, status, next_at, created_at) VALUES ('lane.setup', 'replay-safe', '{}', 'pending', 0, 0)",
      );
    const known = feedPoll("known");
    expect(nextDue(bed.db, now(), ["feed.poll"], NONE, NO_IDS)?.id).toBe(known);
  });

  it("answers the oldest due first, then by id", () => {
    const second = feedPoll("b", { at: now() });
    bed.db.run("UPDATE outbox SET next_at = $n WHERE id = $id", { n: now() - 10, id: second });
    const first = feedPoll("a");
    expect(nextDue(bed.db, now(), ["feed.poll"], NONE, NO_IDS)?.id).toBe(second);
    bed.db.run("UPDATE outbox SET next_at = $n WHERE id = $id", { n: now() - 10, id: first });
    expect(nextDue(bed.db, now(), ["feed.poll"], NONE, new Set([second]))?.id).toBe(first);
  });
});

describe("claimEffect and markSent", () => {
  it("succeeds once, with a lease of the kind's deadline plus 30 s", () => {
    const id = feedPoll("t1");
    expect(claimEffect(bed.db, id, "feed.poll", now())).toBe(true);
    expect(row(id)).toMatchObject({
      status: "leased",
      lease_until: now() + DEADLINE_MS["feed.poll"] + LEASE_SLACK_MS,
    });
    expect(claimEffect(bed.db, id, "feed.poll", now())).toBe(false);
  });

  it("does not claim a row that is not due", () => {
    const id = feedPoll("t1", { at: now() + 1 });
    expect(claimEffect(bed.db, id, "feed.poll", now())).toBe(false);
  });

  it("marks sent only on a leased row", () => {
    const id = feedPoll("t1");
    expect(markSent(bed.db, id, now())).toBe(false);
    lease(id);
    expect(markSent(bed.db, id, now())).toBe(true);
    expect(row(id)?.sent_at).toBe(now());
  });
});

describe("settleEffect", () => {
  it("done settles a leased row", () => {
    const id = feedPoll("t1");
    lease(id);
    settleEffect(bed.db, id, { outcome: "done" }, now());
    expect(row(id)).toMatchObject({ status: "done", settled_at: now(), lease_until: null });
  });

  it("done on a row that is not leased changes nothing", () => {
    const id = feedPoll("t1");
    settleEffect(bed.db, id, { outcome: "done" }, now());
    expect(row(id)).toMatchObject({ status: "pending", settled_at: null });
  });

  it("defer keeps attempts and waits at least 1 s", () => {
    const id = feedPoll("t1");
    lease(id);
    settleEffect(bed.db, id, { outcome: "defer", until: now() }, now());
    expect(row(id)).toMatchObject({ status: "pending", attempts: 0, next_at: now() + 1_000 });
    expect(claimEffect(bed.db, id, "feed.poll", now())).toBe(false);
  });

  it("defer keeps a later time", () => {
    const id = feedPoll("t1");
    lease(id);
    settleEffect(bed.db, id, { outcome: "defer", until: now() + 60_000 }, now());
    expect(row(id)?.next_at).toBe(now() + 60_000);
  });

  it("five retries end in failed with attempts 5 and backoffs 5 s, 10 s, 20 s, 40 s", () => {
    const id = feedPoll("t1");
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      bed.db.run("UPDATE outbox SET next_at = 0 WHERE id = $id", { id });
      lease(id);
      const at = now();
      settleEffect(bed.db, id, { outcome: "retry", code: "boom" }, at);
      if (attempt < 5) delays.push((row(id)?.next_at as number) - at);
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(row(id)).toMatchObject({ status: "failed", attempts: 5, last_error: "boom", settled_at: now() });
  });

  it("fail settles at once with its code, clipped to 64 characters", () => {
    const id = feedPoll("t1");
    lease(id);
    settleEffect(bed.db, id, { outcome: "fail", code: "c".repeat(100) }, now());
    expect(row(id)).toMatchObject({ status: "failed", attempts: 1, last_error: "c".repeat(64) });
  });

  it("a retry after markSent fails the row", () => {
    const id = feedPoll("t1");
    lease(id);
    markSent(bed.db, id, now());
    settleEffect(bed.db, id, { outcome: "retry", code: "late" }, now());
    expect(row(id)).toMatchObject({ status: "failed", last_error: "late" });
  });

  it("a defer after markSent fails the row with defer_after_send", () => {
    const id = feedPoll("t1");
    lease(id);
    markSent(bed.db, id, now());
    settleEffect(bed.db, id, { outcome: "defer", until: now() + 10_000 }, now());
    expect(row(id)).toMatchObject({ status: "failed", last_error: "defer_after_send" });
  });
});

describe("cancelEffect", () => {
  it("retires a pending row once", () => {
    const id = feedPoll("t1", { dedupKey: "k" });
    expect(cancelEffect(bed.db, "k", now())).toBe("retired");
    expect(row(id)).toMatchObject({ status: "retired", last_error: "cancelled", settled_at: now() });
    expect(cancelEffect(bed.db, "k", now())).toBe("none");
  });

  it("marks a leased row, which the handler reads", () => {
    const id = feedPoll("t1", { dedupKey: "k" });
    lease(id);
    expect(cancelRequested(bed.db, id)).toBe(false);
    expect(cancelEffect(bed.db, "k", now())).toBe("marked");
    expect(cancelRequested(bed.db, id)).toBe(true);
    expect(row(id)?.status).toBe("leased");
  });

  it("answers none for a settled row and for an unknown key", () => {
    const id = feedPoll("t1", { dedupKey: "k" });
    lease(id);
    settleEffect(bed.db, id, { outcome: "done" }, now());
    expect(cancelEffect(bed.db, "k", now())).toBe("none");
    expect(cancelEffect(bed.db, "unknown", now())).toBe("none");
  });
});

describe("failures", () => {
  const fail = (id: number) => {
    lease(id);
    settleEffect(bed.db, id, { outcome: "fail", code: "boom" }, now());
  };

  it("lists the owner's failures and the system's, never another owner's", () => {
    const a = feedPoll("a", { ownerId: "A" });
    const b = feedPoll("b", { ownerId: "B" });
    const system = feedPoll("s", { ownerId: null });
    for (const id of [a, b, system]) fail(id);
    expect(
      listFailures(bed.db, "A")
        .map((f) => f.id)
        .sort(),
    ).toEqual([a, system].sort());
    expect(
      listFailures(bed.db, "B")
        .map((f) => f.id)
        .sort(),
    ).toEqual([b, system].sort());
    expect(listFailures(bed.db, "A")[0]).toMatchObject({ kind: "feed.poll", lastError: "boom" });
  });

  it("lists the 20 newest first", () => {
    for (let i = 0; i < 25; i++) {
      fail(feedPoll(`t${i}`, { ownerId: "A" }));
      bed.clock.now();
    }
    const list = listFailures(bed.db, "A");
    expect(list).toHaveLength(20);
    expect(list[0]?.id).toBe(25);
  });

  it("another owner's dismiss is false and changes nothing; the owner dismisses once", () => {
    const a = feedPoll("a", { ownerId: "A" });
    fail(a);
    expect(dismissFailure(bed.db, "B", a)).toBe(false);
    expect(listFailures(bed.db, "A")).toHaveLength(1);
    expect(dismissFailure(bed.db, "A", a)).toBe(true);
    expect(dismissFailure(bed.db, "A", a)).toBe(false);
    expect(listFailures(bed.db, "A")).toHaveLength(0);
  });

  it("does not dismiss a row that did not fail", () => {
    const id = feedPoll("a", { ownerId: "A" });
    expect(dismissFailure(bed.db, "A", id)).toBe(false);
  });
});

describe("purgeOutbox", () => {
  it("removes done and retired rows older than 7 days and keeps failed ones until dismissed", () => {
    const settle = (outcome: "done" | "fail") => {
      const id = feedPoll(`t${Math.random()}`);
      lease(id);
      settleEffect(bed.db, id, outcome === "done" ? { outcome } : { outcome, code: "x" }, now());
      return id;
    };
    const done = settle("done");
    const failed = settle("fail");
    const dismissed = settle("fail");
    dismissFailure(bed.db, "u1", dismissed);
    const retired = feedPoll("r", { dedupKey: "r" });
    cancelEffect(bed.db, "r", now());
    const pending = feedPoll("p");

    expect(purgeOutbox(bed.db, now() + 7 * DAY - 1)).toBe(0);
    expect(purgeOutbox(bed.db, now() + 7 * DAY + 1)).toBe(3);
    const left = bed.db.all<{ id: number }>("SELECT id FROM outbox ORDER BY id").map((r) => r.id);
    expect(left).toEqual([failed, pending]);
    expect([done, dismissed, retired]).toHaveLength(3);
  });
});
