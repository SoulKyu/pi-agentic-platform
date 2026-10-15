import { afterEach, beforeEach, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import { createOutbox, enqueueEffect, type Outbox } from "./index.ts";

let bed: OutboxBed;
let outbox: Outbox;
beforeEach(() => {
  bed = openOutboxBed();
});
afterEach(() => bed.close());

const row = (id: number) =>
  bed.db.get<{ status: string; sent_at: number | null; last_error: string | null }>(
    "SELECT status, sent_at, last_error FROM outbox WHERE id = $id",
    { id },
  );
const resume = (runId: string) =>
  enqueueEffect(
    bed.db,
    { kind: "run.resume", ownerId: "u1", payload: { sessionId: "s", runId, resetAt: 1 } },
    bed.clock.now(),
  ) as number;

it("`<kind>:sent` stops the handler right after its sent mark: marked, leased, the step after the mark never reached", async () => {
  outbox = createOutbox({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    hold: "run.resume:sent",
  });
  const steps: string[] = [];
  outbox.register("run.resume", async (_payload, context) => {
    steps.push("before the mark");
    await context.markSent();
    steps.push("after the mark");
    return { outcome: "done" };
  });
  const id = resume("r1");
  outbox.start();
  await bed.clock.advance(0);
  expect(steps).toEqual(["before the mark"]);
  expect(row(id)).toMatchObject({ status: "leased", sent_at: expect.any(Number) });
  // No stop(): the process dies here, and the next life finds a sent row.
  const next = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
  expect(next.recover()).toEqual({ retired: 1, requeued: 0, failed: 0 });
  expect(row(id)).toMatchObject({ status: "retired", last_error: "crash" });
  await outbox.stop();
});

it("`<kind>:sent` never lets the step after the mark run, not even when the daemon stops", async () => {
  outbox = createOutbox({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    hold: "run.resume:sent",
  });
  const steps: string[] = [];
  outbox.register("run.resume", async (_payload, context) => {
    await context.markSent();
    steps.push("after the mark");
    return { outcome: "done" };
  });
  const id = resume("r1");
  outbox.start();
  await bed.clock.advance(0);
  await outbox.stop();
  expect(steps).toEqual([]);
  expect(row(id)?.status).toBe("failed");
});

it("`<kind>` alone keeps the handler out before any mark, and `cancel` holds no handler at all", async () => {
  outbox = createOutbox({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: false,
    hold: "cancel",
  });
  let called = 0;
  outbox.register("run.resume", async () => {
    called++;
    return { outcome: "done" };
  });
  const id = resume("r1");
  outbox.start();
  await bed.clock.advance(0);
  expect(called).toBe(1);
  expect(row(id)?.status).toBe("done");
  await outbox.stop();
});
