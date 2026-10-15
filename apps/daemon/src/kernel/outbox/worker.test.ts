import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/database.ts";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import {
  createOutbox,
  enqueueEffect,
  type EffectHandler,
  type EffectKind,
  type Outbox,
  type Settlement,
} from "./index.ts";

let bed: OutboxBed;
let outbox: Outbox;
beforeEach(() => {
  bed = openOutboxBed();
  outbox = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
});
afterEach(() => bed.close());

function deferred<T = Settlement>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const DONE: Settlement = { outcome: "done" };
const status = (id: number) =>
  bed.db.get<{ status: string; attempts: number; last_error: string | null }>(
    "SELECT status, attempts, last_error FROM outbox WHERE id = $id",
    { id },
  );
const now = () => bed.clock.now();
const task = (taskId: string) =>
  enqueueEffect(bed.db, { kind: "task.start", ownerId: "u1", payload: { taskId } }, now()) as number;
const poll = (triggerId: string) =>
  enqueueEffect(bed.db, { kind: "feed.poll", ownerId: "u1", payload: { triggerId } }, now()) as number;
const resume = (runId: string) =>
  enqueueEffect(
    bed.db,
    { kind: "run.resume", ownerId: "u1", payload: { sessionId: "s", runId, resetAt: 1 } },
    now(),
  ) as number;

describe("concurrency", () => {
  it("runs a feed.poll and a task.start at once, and a second task.start waits for the first", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<Settlement>>>();
    const gated =
      (name: string): EffectHandler<EffectKind> =>
      async (payload) => {
        const key = `${name}:${JSON.stringify(payload)}`;
        started.push(key);
        const gate = deferred();
        gates.set(key, gate);
        return gate.promise;
      };
    outbox.register("task.start", gated("task") as EffectHandler<"task.start">);
    outbox.register("feed.poll", gated("poll") as EffectHandler<"feed.poll">);
    task("a");
    task("b");
    poll("f");
    outbox.start();
    await bed.clock.advance(0);

    expect(started).toEqual(['task:{"taskId":"a"}', 'poll:{"triggerId":"f"}']);
    gates.get('task:{"taskId":"a"}')?.resolve(DONE);
    await bed.clock.advance(0);
    expect(started).toEqual(['task:{"taskId":"a"}', 'poll:{"triggerId":"f"}', 'task:{"taskId":"b"}']);
    for (const gate of gates.values()) gate.resolve(DONE);
    await outbox.stop();
  });

  it("never has more than two effects in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<ReturnType<typeof deferred<Settlement>>> = [];
    const handler = async (): Promise<Settlement> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const gate = deferred();
      gates.push(gate);
      const result = await gate.promise;
      inFlight--;
      return result;
    };
    outbox.register("task.start", handler);
    outbox.register("feed.poll", handler);
    outbox.register("run.resume", handler);
    task("a");
    poll("f");
    resume("r");
    outbox.start();
    await bed.clock.advance(0);
    expect(gates).toHaveLength(2);
    gates[0]?.resolve(DONE);
    await bed.clock.advance(0);
    expect(gates).toHaveLength(3);
    gates[1]?.resolve(DONE);
    gates[2]?.resolve(DONE);
    await bed.clock.advance(0);
    expect(peak).toBe(2);
    await outbox.stop();
  });

  it("runs the oldest due first", async () => {
    const order: string[] = [];
    outbox.register("feed.poll", async (payload) => {
      order.push(payload.triggerId);
      return DONE;
    });
    poll("first");
    await bed.clock.advance(10);
    poll("second");
    outbox.start();
    await bed.clock.advance(0);
    expect(order).toEqual(["first", "second"]);
    await outbox.stop();
  });

  it("does not run a kind that has no handler, and does not spin on it", async () => {
    outbox.register("feed.poll", async () => DONE);
    const orphan = task("a");
    const ran = poll("f");
    outbox.start();
    await bed.clock.advance(0);
    expect(status(orphan)?.status).toBe("pending");
    expect(status(ran)?.status).toBe("done");
    expect(bed.clock.pending()).toBe(0);
    await outbox.stop();
  });

  it("holds the kind named by the test seam: leased, handler not called, released by stop", async () => {
    outbox = createOutbox({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      hold: "feed.poll",
    });
    let called = 0;
    outbox.register("feed.poll", async () => {
      called++;
      return DONE;
    });
    const held = poll("f");
    const other = task("t");
    outbox.register("task.start", async () => DONE);
    outbox.start();
    await bed.clock.advance(0);
    expect(status(held)?.status).toBe("leased");
    expect(status(other)?.status).toBe("done");
    expect(called).toBe(0);
    await outbox.stop();
    expect(called).toBe(0);
    expect(status(held)).toEqual({ status: "pending", attempts: 1, last_error: "held" });
  });

  it("a held row is what the boot finds after a kill: process-bound retired, replay-safe requeued", async () => {
    outbox = createOutbox({
      db: bed.db,
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      hold: "task.start",
    });
    outbox.register("task.start", async () => DONE);
    const started = task("t");
    outbox.start();
    await bed.clock.advance(0);
    expect(status(started)?.status).toBe("leased");
    // No stop(): the process dies here. The next life recovers from the database alone.
    const next = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
    expect(next.recover()).toEqual({ retired: 1, requeued: 0, failed: 0 });
    expect(status(started)).toMatchObject({ status: "retired", last_error: "crash" });
    await outbox.stop();
  });
});

describe("driving the loop", () => {
  it("poke runs an effect enqueued after start on the next turn", async () => {
    let runs = 0;
    outbox.register("feed.poll", async () => {
      runs++;
      return DONE;
    });
    outbox.start();
    await bed.clock.advance(0);
    poll("f");
    expect(runs).toBe(0);
    outbox.poke();
    await bed.clock.advance(0);
    expect(runs).toBe(1);
    await outbox.stop();
  });

  it("wakes by itself when a later effect becomes due", async () => {
    let runs = 0;
    outbox.register("feed.poll", async () => {
      runs++;
      return DONE;
    });
    enqueueEffect(
      bed.db,
      { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "f" }, at: now() + 60_000 },
      now(),
    );
    outbox.start();
    await bed.clock.advance(59_999);
    expect(runs).toBe(0);
    await bed.clock.advance(1);
    expect(runs).toBe(1);
    await outbox.stop();
  });

  it("drain runs every due effect, two kinds at once at most, and counts them", async () => {
    let inFlight = 0;
    let peak = 0;
    const handler = async (): Promise<Settlement> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await bed.clock.sleep(0);
      inFlight--;
      return DONE;
    };
    outbox.register("task.start", handler);
    outbox.register("feed.poll", handler);
    outbox.register("run.resume", handler);
    task("a");
    task("b");
    poll("f");
    resume("r");
    enqueueEffect(
      bed.db,
      { kind: "feed.poll", ownerId: "u1", payload: { triggerId: "later" }, at: now() + 5_000 },
      now(),
    );
    const draining = outbox.drain();
    await bed.clock.advance(0);
    await bed.clock.advance(0);
    await bed.clock.advance(0);
    expect(await draining).toBe(4);
    expect(peak).toBe(2);
    expect(bed.db.all("SELECT id FROM outbox WHERE status = 'pending'")).toHaveLength(1);
  });

  it("refuses a second registration of the same kind", () => {
    outbox.register("feed.poll", async () => DONE);
    expect(() => outbox.register("feed.poll", async () => DONE)).toThrow(/feed\.poll/);
  });

  it("logs a store failure inside the loop's timer and arms the next tick", async () => {
    let failures = 1;
    const flaky: Db = {
      ...bed.db,
      get: <T>(sql: string, params?: Parameters<Db["get"]>[1]) => {
        if (failures > 0 && sql.includes("LIMIT 1")) {
          failures--;
          throw new Error("database is locked");
        }
        return bed.db.get<T>(sql, params);
      },
    };
    outbox = createOutbox({ db: flaky, clock: bed.clock, logger: bed.logger, readOnly: false });
    let runs = 0;
    outbox.register("feed.poll", async () => {
      runs++;
      return DONE;
    });
    poll("f");
    outbox.start();
    await bed.clock.advance(0);
    expect(bed.logs.filter((l) => l.msg === "outbox_loop_failed")).toHaveLength(1);
    expect(runs).toBe(0);
    expect(bed.clock.pending()).toBe(1);
    await bed.clock.advance(30_000);
    expect(runs).toBe(1);
    await outbox.stop();
  });
});
