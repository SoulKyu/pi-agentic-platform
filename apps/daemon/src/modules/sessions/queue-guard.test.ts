import { PapError, QueueView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  createQueueGuard,
  fitTexts,
  MAX_QUEUED_BYTES,
  MAX_QUEUED_MESSAGES,
  QUEUE_PREVIEW_BYTES,
} from "./queue-guard.ts";
import { fitSnapshot, SNAPSHOT_BYTES, sizeOf } from "./snapshot.ts";

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
    expect(sizeOf({ kind: "queue", queue: view })).toBeLessThanOrEqual(QUEUE_PREVIEW_BYTES);
    expect(view.steering.length + view.followUp.length).toBeGreaterThan(0);
    expect(view.count).toBe(256);
  });

  it("uncounts the bytes of a prompt too, once, so 32 MiB of prompts over time do not wedge the session", () => {
    const guard = createQueueGuard();
    const full = "x".repeat(MAX_QUEUED_BYTES);
    const release = guard.admit(full);
    expect(() => guard.admit("y")).toThrow(new PapError("queue_full"));
    release();
    release();
    const again = guard.admit(full);
    expect(() => guard.admit("y")).toThrow(new PapError("queue_full"));
    again();
  });

  it("does not let a release that comes after a reset uncount what was admitted since", () => {
    const guard = createQueueGuard();
    const stale = Array.from({ length: MAX_QUEUED_MESSAGES }, () => guard.admit("a"));
    guard.reset();
    guard.admit("b");
    stale.forEach((release) => release());
    for (let i = 1; i < MAX_QUEUED_MESSAGES; i++) guard.admit("c");
    expect(() => guard.admit("d")).toThrow(new PapError("queue_full"));
  });

  it("keeps a snapshot's room for an approval whatever the queue holds (the full 128 / 32 MiB, escape-heavy)", () => {
    const guard = createQueueGuard();
    const nasty = '"\\\u0000\u001f'.repeat(500);
    const texts = Array.from({ length: 128 }, () => nasty);
    const queue = guard.onQueueUpdate({
      steering: texts,
      followUp: texts,
      count: 128,
      bytes: MAX_QUEUED_BYTES,
    });
    const approval = { id: "d1", method: "approval" as const, title: "Run?", message: "m".repeat(200_000) };
    const snapshot = fitSnapshot({ status: "running", rows: [], dialogs: [approval] as never, queue });
    expect(snapshot.dialogs).toHaveLength(1);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    expect(snapshot.queue.count).toBe(128);
  });

  it("ignores what is not a list of texts, and negative or fractional totals", () => {
    const guard = createQueueGuard();
    expect(
      guard.onQueueUpdate({ steering: "no", followUp: [1, "ok"], count: -4, bytes: 2.9 } as never),
    ).toEqual({ steering: [], followUp: ["ok"], count: 0, bytes: 2 });
  });
});

describe("fitTexts", () => {
  it("keeps a contiguous prefix: it stops at the first text that does not fit", () => {
    const fitted = fitTexts(["a", "b".repeat(100), "c"], ["d"], 20);
    expect(fitted).toEqual({ steering: ["a"], followUp: [], truncated: true });
  });

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
