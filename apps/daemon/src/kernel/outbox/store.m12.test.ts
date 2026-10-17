import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOutboxBed, type OutboxBed } from "../testing/outbox-bed.ts";
import { createOutbox, enqueueEffect, type Outbox } from "./index.ts";
import { DEADLINE_MS, REPLAY } from "./store.ts";

let bed: OutboxBed;
let outbox: Outbox;
beforeEach(() => {
  bed = openOutboxBed();
  outbox = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
});
afterEach(() => bed.close());

const EVENT_ID = "abcdefghijklmnopqrstuv";

describe("the push kinds (M12R21)", () => {
  it("declares push.send and digest.send replay-safe with a 30 s deadline", () => {
    expect(REPLAY["push.send"]).toBe("replay-safe");
    expect(REPLAY["digest.send"]).toBe("replay-safe");
    expect(DEADLINE_MS["push.send"]).toBe(30_000);
    expect(DEADLINE_MS["digest.send"]).toBe(30_000);
  });

  it("registers a handler for each kind once; a second registration throws", () => {
    outbox.register("push.send", async () => ({ outcome: "done" }));
    outbox.register("digest.send", async () => ({ outcome: "done" }));
    expect(() => outbox.register("push.send", async () => ({ outcome: "done" }))).toThrow(
      "outbox handler already registered: push.send",
    );
    expect(() => outbox.register("digest.send", async () => ({ outcome: "done" }))).toThrow(
      "outbox handler already registered: digest.send",
    );
  });

  it("takes a push.send for a 22-character event id and refuses any other shape", () => {
    const now = bed.clock.now();
    const id = enqueueEffect(
      bed.db,
      { kind: "push.send", ownerId: "u1", payload: { eventId: EVENT_ID }, dedupKey: `push.send:${EVENT_ID}` },
      now,
    );
    expect(id).toEqual(expect.any(Number));
    for (const eventId of ["short", "123e4567-e89b-12d3-a456-426614174000", `${EVENT_ID}x`]) {
      expect(() =>
        enqueueEffect(
          bed.db,
          { kind: "push.send", ownerId: "u1", payload: { eventId }, dedupKey: eventId },
          now,
        ),
      ).toThrow();
    }
    expect(() =>
      enqueueEffect(
        bed.db,
        { kind: "push.send", ownerId: "u1", payload: { eventId: EVENT_ID, extra: 1 } as never },
        now,
      ),
    ).toThrow();
  });

  it("takes a digest.send for an owner and an end minute", () => {
    const now = bed.clock.now();
    expect(
      enqueueEffect(
        bed.db,
        {
          kind: "digest.send",
          ownerId: "u1",
          payload: { ownerId: "u1", endMinute: 480 },
          dedupKey: "digest:u1:480",
        },
        now,
      ),
    ).toEqual(expect.any(Number));
    expect(() =>
      enqueueEffect(
        bed.db,
        { kind: "digest.send", ownerId: "u1", payload: { ownerId: "u1", endMinute: 1.5 } },
        now,
      ),
    ).toThrow();
  });
});
