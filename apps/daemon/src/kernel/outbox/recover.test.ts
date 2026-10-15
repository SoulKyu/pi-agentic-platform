import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import { createOutbox } from "./index.ts";
import { claimEffect, enqueueEffect, markSent, MAX_ATTEMPTS, recoverOutbox } from "./store.ts";

let bed: OutboxBed;
beforeEach(() => {
  bed = openOutboxBed();
});
afterEach(() => bed.close());

const now = () => bed.clock.now();
const status = (id: number) =>
  bed.db.get<{ status: string; last_error: string | null; next_at: number; settled_at: number | null }>(
    "SELECT status, last_error, next_at, settled_at FROM outbox WHERE id = $id",
    { id },
  );

interface Seeded {
  leasedTask: number;
  leasedPoll: number;
  sentResume: number;
  pendingTask: number;
  futureResume: number;
}

function seed(): Seeded {
  const resume = (runId: string, at?: number) =>
    enqueueEffect(
      bed.db,
      {
        kind: "run.resume",
        ownerId: "u1",
        payload: { sessionId: "s", runId, resetAt: 1 },
        ...(at ? { at } : {}),
      },
      now(),
    ) as number;
  const leasedTask = enqueueEffect(
    bed.db,
    { kind: "task.start", ownerId: "u1", payload: { taskId: "t1" } },
    now(),
  ) as number;
  const leasedPoll = enqueueEffect(
    bed.db,
    { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "f1" } },
    now(),
  ) as number;
  const sentResume = resume("r1");
  const pendingTask = enqueueEffect(
    bed.db,
    { kind: "task.start", ownerId: "u1", payload: { taskId: "t2" } },
    now(),
  ) as number;
  const futureResume = resume("r2", now() + 3_600_000);
  claimEffect(bed.db, leasedTask, "task.start", now());
  claimEffect(bed.db, leasedPoll, "feed.poll", now());
  claimEffect(bed.db, sentResume, "run.resume", now());
  markSent(bed.db, sentResume, now());
  return { leasedTask, leasedPoll, sentResume, pendingTask, futureResume };
}

describe("recoverOutbox", () => {
  it("retires process-bound and sent rows, requeues the other leased replay-safe row, leaves pending ones", async () => {
    const ids = seed();
    await bed.clock.advance(1_000);
    const at = now();
    const before = {
      pendingTask: status(ids.pendingTask),
      futureResume: status(ids.futureResume),
    };

    expect(recoverOutbox(bed.db, at)).toEqual({ retired: 2, requeued: 1, failed: 0 });

    expect(status(ids.leasedTask)).toMatchObject({ status: "retired", last_error: "crash", settled_at: at });
    expect(status(ids.sentResume)).toMatchObject({ status: "retired", last_error: "crash", settled_at: at });
    expect(status(ids.leasedPoll)).toMatchObject({ status: "pending", next_at: at, settled_at: null });
    expect(status(ids.pendingTask)).toEqual(before.pendingTask);
    expect(status(ids.futureResume)).toEqual(before.futureResume);
    expect(bed.db.get("SELECT 1 AS x FROM outbox WHERE status = 'leased'")).toBeUndefined();
  });

  it("counts an attempt for a requeued row, and fails it at the limit instead of running it again (no crash loop)", async () => {
    const id = enqueueEffect(
      bed.db,
      { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "f1" } },
      now(),
    ) as number;
    const attemptsOf = () =>
      bed.db.get<{ attempts: number }>("SELECT attempts FROM outbox WHERE id = $id", { id })?.attempts;
    // The daemon dies in the effect at every boot: four boots requeue it, the fifth gives up.
    for (let boot = 1; boot < MAX_ATTEMPTS; boot++) {
      claimEffect(bed.db, id, "feed.poll", now());
      expect(recoverOutbox(bed.db, now())).toEqual({ retired: 0, requeued: 1, failed: 0 });
      expect(attemptsOf()).toBe(boot);
      expect(status(id)).toMatchObject({ status: "pending" });
    }
    claimEffect(bed.db, id, "feed.poll", now());
    expect(recoverOutbox(bed.db, now())).toEqual({ retired: 0, requeued: 0, failed: 1 });
    expect(attemptsOf()).toBe(MAX_ATTEMPTS);
    expect(status(id)).toMatchObject({ status: "failed", last_error: "crash", settled_at: now() });
  });

  it("is idempotent: a second run finds nothing", () => {
    seed();
    recoverOutbox(bed.db, now());
    expect(recoverOutbox(bed.db, now())).toEqual({ retired: 0, requeued: 0, failed: 0 });
  });
});

describe("Outbox.recover", () => {
  const make = (readOnly = false) =>
    createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly });

  it("recovers and logs what it did", () => {
    seed();
    expect(make().recover()).toEqual({ retired: 2, requeued: 1, failed: 0 });
    expect(bed.logs.find((l) => l.msg === "outbox_recovered")).toMatchObject({
      retired: 2,
      requeued: 1,
      failed: 0,
    });
  });

  it("logs an effect that reached the attempt limit as failed, even when nothing else was recovered", () => {
    const id = enqueueEffect(
      bed.db,
      { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "f1" } },
      now(),
    ) as number;
    bed.db.run("UPDATE outbox SET attempts = $n WHERE id = $id", { n: MAX_ATTEMPTS - 1, id });
    claimEffect(bed.db, id, "feed.poll", now());
    expect(make().recover()).toEqual({ retired: 0, requeued: 0, failed: 1 });
    expect(bed.logs.find((l) => l.msg === "outbox_recovered")).toMatchObject({ failed: 1 });
  });

  it("keeps a row of a kind this binary does not know pending and reports it once", () => {
    bed.db.run(
      "INSERT INTO outbox (kind, replay, payload, status, next_at, created_at) VALUES ('lane.setup', 'process-bound', '{}', 'pending', 0, 0)",
    );
    bed.db.run(
      "INSERT INTO outbox (kind, replay, payload, status, next_at, lease_until, created_at) VALUES ('lane.setup', 'replay-safe', '{}', 'leased', 0, 9, 0)",
    );
    const outbox = make();
    outbox.recover();
    const rows = bed.db.all<{ status: string }>("SELECT status FROM outbox ORDER BY id").map((r) => r.status);
    expect(rows).toEqual(["pending", "pending"]);
    expect(bed.logs.filter((l) => l.msg === "outbox_unknown_kinds")).toEqual([
      expect.objectContaining({ count: 2 }),
    ]);
  });

  it("logs nothing about unknown kinds when there are none", () => {
    make().recover();
    expect(bed.logs.some((l) => l.msg === "outbox_unknown_kinds")).toBe(false);
  });

  it("changes no row in read-only mode and arms no timer", () => {
    const ids = seed();
    const outbox = make(true);
    expect(outbox.recover()).toEqual({ retired: 0, requeued: 0, failed: 0 });
    outbox.start();
    outbox.poke();
    expect(bed.clock.pending()).toBe(0);
    expect(status(ids.leasedTask)?.status).toBe("leased");
    expect(status(ids.leasedPoll)?.status).toBe("leased");
  });
});
