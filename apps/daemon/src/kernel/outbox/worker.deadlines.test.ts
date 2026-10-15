import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import {
  createOutbox,
  enqueueEffect,
  type EffectContext,
  type EffectHandler,
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

describe("deadlines and results", () => {
  it("settles a task.start that resolves at 35 s with its own result, never as failed", async () => {
    outbox.register("task.start", async () => {
      await bed.clock.sleep(35_000);
      return DONE;
    });
    const id = task("a");
    outbox.start();
    await bed.clock.advance(34_999);
    expect(status(id)?.status).toBe("leased");
    await bed.clock.advance(1);
    expect(status(id)).toEqual({ status: "done", attempts: 0, last_error: null });
    await outbox.stop();
  });

  it("aborts the signal at the kind's deadline and stores the handler's retry", async () => {
    let signal!: AbortSignal;
    outbox.register("task.start", async (_payload, context) => {
      signal = context.signal;
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve()));
      return { outcome: "retry", code: "deadline" };
    });
    const id = task("a");
    outbox.start();
    await bed.clock.advance(89_999);
    expect(signal.aborted).toBe(false);
    await bed.clock.advance(1);
    expect(signal.aborted).toBe(true);
    expect(status(id)).toEqual({ status: "pending", attempts: 1, last_error: "deadline" });
    await outbox.stop();
  });

  it("keeps the row leased and the kind busy while a handler ignores the abort, logs it once, then settles its result", async () => {
    const gate = deferred();
    const started: string[] = [];
    outbox.register("task.start", async (payload) => {
      started.push(payload.taskId);
      return started.length === 1 ? gate.promise : DONE;
    });
    const first = task("a");
    const second = task("b");
    outbox.start();
    await bed.clock.advance(90_000);
    expect(status(first)?.status).toBe("leased");
    expect(bed.logs.filter((l) => l.msg === "outbox_handler_overdue")).toEqual([]);
    await bed.clock.advance(14_999);
    expect(bed.logs.filter((l) => l.msg === "outbox_handler_overdue")).toEqual([]);
    await bed.clock.advance(1);
    await bed.clock.advance(60_000);
    expect(bed.logs.filter((l) => l.msg === "outbox_handler_overdue")).toEqual([
      expect.objectContaining({ kind: "task.start" }),
    ]);
    expect(status(first)?.status).toBe("leased");
    expect(started).toEqual(["a"]);

    gate.resolve(DONE);
    await bed.clock.advance(0);
    expect(status(first)?.status).toBe("done");
    expect(status(second)?.status).toBe("done");
    expect(started).toEqual(["a", "b"]);
    await outbox.stop();
  });

  it("turns a throwing handler into a retry with handler_error", async () => {
    outbox.register("feed.poll", async () => {
      throw new Error("provider said: secret text");
    });
    const id = poll("f");
    outbox.start();
    await bed.clock.advance(0);
    expect(status(id)).toEqual({ status: "pending", attempts: 1, last_error: "handler_error" });
    await outbox.stop();
  });

  it("turns a handler that returns nothing valid into a handler_error retry", async () => {
    outbox.register("feed.poll", (async () => undefined) as unknown as EffectHandler<"feed.poll">);
    const id = poll("f");
    outbox.start();
    await bed.clock.advance(0);
    expect(status(id)).toEqual({ status: "pending", attempts: 1, last_error: "handler_error" });
    await outbox.stop();
  });

  it("fails a row whose payload no longer parses, without calling the handler", async () => {
    let called = 0;
    outbox.register("feed.poll", async () => {
      called++;
      return DONE;
    });
    bed.db.run(
      "INSERT INTO outbox (kind, replay, payload, status, next_at, created_at) VALUES ('feed.poll', 'replay-safe', '{\"nope\":1}', 'pending', 0, 0)",
    );
    outbox.start();
    await bed.clock.advance(0);
    expect(called).toBe(0);
    expect(bed.db.get("SELECT status, last_error FROM outbox")).toMatchObject({
      status: "failed",
      last_error: "bad_payload",
    });
    await outbox.stop();
  });

  it("re-runs a deferral at its time and does not count an attempt", async () => {
    let runs = 0;
    outbox.register("feed.poll", async () => {
      runs++;
      return runs === 1 ? { outcome: "defer", until: now() + 10_000 } : DONE;
    });
    const id = poll("f");
    outbox.start();
    await bed.clock.advance(9_999);
    expect(runs).toBe(1);
    expect(status(id)).toEqual({ status: "pending", attempts: 0, last_error: null });
    await bed.clock.advance(1);
    expect(runs).toBe(2);
    expect(status(id)?.status).toBe("done");
    await outbox.stop();
  });

  it("retries with the backoff and fails the fifth attempt", async () => {
    outbox.register("feed.poll", async () => ({ outcome: "retry", code: "again" }));
    const id = poll("f");
    outbox.start();
    await bed.clock.advance(0);
    expect(status(id)?.attempts).toBe(1);
    await bed.clock.advance(4_999);
    expect(status(id)?.attempts).toBe(1);
    await bed.clock.advance(1);
    expect(status(id)?.attempts).toBe(2);
    await bed.clock.advance(10_000 + 20_000 + 40_000);
    expect(status(id)).toEqual({ status: "failed", attempts: 5, last_error: "again" });
    expect(bed.clock.pending()).toBe(0);
    await outbox.stop();
  });

  it("gives the handler its context: id, attempts, owner, and the two marks", async () => {
    const seen: Array<
      Pick<EffectContext, "effectId" | "attempts" | "ownerId"> & {
        cancelled: boolean;
        cancelledAfter: boolean;
      }
    > = [];
    outbox.register("run.resume", async (_payload, context) => {
      const cancelled = context.cancelRequested();
      context.markSent();
      outbox.cancel("resume-1");
      seen.push({
        effectId: context.effectId,
        attempts: context.attempts,
        ownerId: context.ownerId,
        cancelled,
        cancelledAfter: context.cancelRequested(),
      });
      return { outcome: "retry", code: "after_send" };
    });
    const id = enqueueEffect(
      bed.db,
      {
        kind: "run.resume",
        ownerId: "u1",
        payload: { sessionId: "s", runId: "r", resetAt: 1 },
        dedupKey: "resume-1",
      },
      now(),
    ) as number;
    outbox.start();
    await bed.clock.advance(0);
    expect(seen).toEqual([
      { effectId: id, attempts: 0, ownerId: "u1", cancelled: false, cancelledAfter: true },
    ]);
    expect(status(id)).toEqual({ status: "failed", attempts: 1, last_error: "after_send" });
    await outbox.stop();
  });
});

describe("stop", () => {
  it("aborts the in-flight signal, waits for the handler, then leaves no timer", async () => {
    let signal!: AbortSignal;
    outbox.register("task.start", async (_payload, context) => {
      signal = context.signal;
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve()));
      return { outcome: "retry", code: "stopped" };
    });
    const id = task("a");
    outbox.start();
    await bed.clock.advance(0);
    expect(signal.aborted).toBe(false);
    await outbox.stop();
    expect(signal.aborted).toBe(true);
    expect(status(id)).toEqual({ status: "pending", attempts: 1, last_error: "stopped" });
    expect(bed.clock.pending()).toBe(0);
  });

  it("starts nothing after stop, even on poke", async () => {
    let runs = 0;
    outbox.register("feed.poll", async () => {
      runs++;
      return DONE;
    });
    outbox.start();
    await outbox.stop();
    poll("f");
    outbox.poke();
    await bed.clock.advance(1_000);
    expect(runs).toBe(0);
    expect(bed.clock.pending()).toBe(0);
  });

  it("gives up on a handler that ignores the abort after 20 s, logs it and leaves the row leased for the boot", async () => {
    outbox.register("task.start", () => new Promise<Settlement>(() => {}));
    const id = task("a");
    outbox.start();
    await bed.clock.advance(0);
    const stopping = outbox.stop();
    await bed.clock.advance(20_000);
    await stopping;
    expect(bed.logs.some((l) => l.msg === "outbox_stop_timeout")).toBe(true);
    expect(status(id)?.status).toBe("leased");
    expect(bed.clock.pending()).toBe(0);
  });
});
