import { PapError, QueueView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createQueueGuard, fitTexts, MAX_QUEUED_BYTES, MAX_QUEUED_MESSAGES } from "./queue-guard.ts";
import { PAGE_BYTES, sizeOf } from "./snapshot.ts";

const update = (count: number, bytes: number) => ({
  steering: Array.from({ length: Math.min(count, 128) }, () => "s"),
  followUp: [],
  count,
  bytes,
});

describe("queue guard", () => {
  it("counts what Pi holds plus what is on its way, and refuses the 129th", () => {
    const guard = createQueueGuard();
    guard.onQueueUpdate(update(MAX_QUEUED_MESSAGES - 1, 10));
    const release = guard.admit("one more");
    expect(() => guard.admit("too many")).toThrow(new PapError("queue_full"));
    release();
    expect(() => guard.admit("fits again")).not.toThrow();
  });

  it("refuses what would pass 32 MiB", () => {
    const guard = createQueueGuard();
    guard.onQueueUpdate(update(1, MAX_QUEUED_BYTES - 4));
    expect(() => guard.admit("12345")).toThrow(new PapError("queue_full"));
    expect(() => guard.admit("1234")).not.toThrow();
  });

  it("uncounts a prompt once, however often it is released", () => {
    const guard = createQueueGuard();
    guard.onQueueUpdate(update(MAX_QUEUED_MESSAGES - 2, 10));
    const release = guard.admit("a");
    release();
    release();
    guard.admit("b");
    guard.admit("c");
    expect(() => guard.admit("d")).toThrow(new PapError("queue_full"));
  });

  it("shows previews and the totals, and empties on reset", () => {
    const guard = createQueueGuard();
    expect(guard.onQueueUpdate({ steering: ["left"], followUp: ["after"], count: 2, bytes: 9 })).toEqual({
      steering: ["left"],
      followUp: ["after"],
      count: 2,
      bytes: 9,
    });
    guard.reset();
    expect(guard.view()).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
  });

  it("keeps a preview that is not the worker's promise inside the contract and the frame (worst-case content)", () => {
    const guard = createQueueGuard();
    const nasty = '"\\\u0000\u001f'.repeat(1000);
    const view = guard.onQueueUpdate({
      steering: Array.from({ length: 128 }, () => nasty),
      followUp: Array.from({ length: 128 }, () => nasty),
      count: 256,
      bytes: 123,
    });
    expect(QueueView.safeParse(view).success).toBe(true);
    expect(sizeOf({ kind: "queue", queue: view })).toBeLessThanOrEqual(PAGE_BYTES);
    expect(view.steering.length + view.followUp.length).toBeGreaterThan(0);
    expect(view.count).toBe(256);
  });

  it("ignores what is not a list of texts, and negative or fractional totals", () => {
    const guard = createQueueGuard();
    expect(
      guard.onQueueUpdate({ steering: "no", followUp: [1, "ok"], count: -4, bytes: 2.9 } as never),
    ).toEqual({ steering: [], followUp: ["ok"], count: 0, bytes: 2 });
  });
});

describe("fitTexts", () => {
  it("fits in JSON bytes and says when it left something out", () => {
    const nasty = "\u0000".repeat(10_000);
    const texts = Array.from({ length: 128 }, () => nasty);
    const fitted = fitTexts(texts, texts, 100_000);
    expect(fitted.truncated).toBe(true);
    expect(sizeOf(fitted)).toBeLessThanOrEqual(100_000);
    expect(fitted.steering).toHaveLength(Math.floor(100_000 / (60_002 + 1)));
    expect(fitTexts(["a"], ["b"], 100)).toEqual({ steering: ["a"], followUp: ["b"], truncated: false });
  });
});
