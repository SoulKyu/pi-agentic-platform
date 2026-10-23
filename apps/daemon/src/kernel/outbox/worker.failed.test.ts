import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import { createOutbox, enqueueEffect, type FailedEffect, type Outbox, type Settlement } from "./index.ts";

let bed: OutboxBed;
let outbox: Outbox;
beforeEach(() => {
  bed = openOutboxBed();
  outbox = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
});
afterEach(() => bed.close());

const cleanup = (ownerId: string | null) =>
  enqueueEffect(
    bed.db,
    { kind: "attachment.cleanup", ownerId, payload: { day: "2026-10-14" } },
    bed.clock.now(),
  ) as number;

describe("onOverdue", () => {
  it("notifies overdue listeners with the row's owner", async () => {
    const heard: Array<{ id: number; kind: string; ownerId: string | null }> = [];
    outbox.onOverdue((overdue) => void heard.push(overdue));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    outbox.register("attachment.cleanup", () => gate.then(() => ({ outcome: "done" as const })));
    const id = cleanup("u1");
    const drained = outbox.drain();
    await bed.clock.advance(30_000); // the deadline aborts the handler
    await bed.clock.advance(15_000); // ... and it is overdue this long after
    expect(heard).toEqual([{ id, kind: "attachment.cleanup", ownerId: "u1" }]);
    release();
    await drained;
  });
});

describe("onFailed", () => {
  it("tells the listener when an effect settles as failed, with its owner and its short code", async () => {
    const heard: FailedEffect[] = [];
    outbox.onFailed((failure) => void heard.push(failure));
    outbox.register("attachment.cleanup", async () => ({ outcome: "fail", code: "boom" }));
    const id = cleanup("u1");
    await outbox.drain();
    expect(heard).toEqual([
      { id, kind: "attachment.cleanup", ownerId: "u1", lastError: "boom", settledAt: bed.clock.now() },
    ]);
  });

  it("tells it for a system effect with a null owner, and not for a done or a retried effect", async () => {
    const heard: FailedEffect[] = [];
    outbox.onFailed((failure) => void heard.push(failure));
    let outcome: Settlement = { outcome: "retry", code: "later" };
    outbox.register("attachment.cleanup", async () => outcome);
    cleanup(null);
    await outbox.drain();
    expect(heard).toEqual([]);
    outcome = { outcome: "done" };
    await bed.clock.advance(10_000);
    await outbox.drain();
    expect(heard).toEqual([]);
    outcome = { outcome: "fail", code: "x" };
    cleanup(null);
    bed.db.run("UPDATE outbox SET dedup_key = NULL");
    await outbox.drain();
    expect(heard).toMatchObject([{ ownerId: null, lastError: "x" }]);
  });

  it("isolates a throwing listener and stops hearing after the returned function is called", async () => {
    const heard: number[] = [];
    outbox.onFailed(() => {
      throw new Error("listener broke");
    });
    const stop = outbox.onFailed((failure) => void heard.push(failure.id));
    outbox.register("attachment.cleanup", async () => ({ outcome: "fail", code: "boom" }));
    const first = cleanup("u1");
    await outbox.drain();
    expect(heard).toEqual([first]);
    expect(bed.logs.some((line) => line.msg === "outbox_failed_listener_error")).toBe(true);
    stop();
    cleanup("u1");
    await bed.clock.advance(1);
    await outbox.drain();
    expect(heard).toEqual([first]);
  });
});
