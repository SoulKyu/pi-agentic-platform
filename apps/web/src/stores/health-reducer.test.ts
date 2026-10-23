import type { HealthEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { appendHealthPage, EMPTY_HEALTH, reduceHealth } from "./health-reducer.ts";

const event = (over: Partial<HealthEvent> = {}): HealthEvent => ({
  seq: 3,
  ts: 1_760_000_000_000,
  kind: "feed",
  severity: "err",
  code: "not_a_feed",
  sourceRef: { kind: "trigger", id: "g1", name: "K8s Blog" },
  count: 1,
  ...over,
});

describe("reduceHealth", () => {
  it("a snapshot replaces everything and sorts newest first", () => {
    const view = reduceHealth(EMPTY_HEALTH, {
      kind: "snapshot",
      events: [event({ seq: 3 }), event({ seq: 9 })],
      hasMore: true,
    });
    expect(view).toEqual({
      loaded: true,
      events: [event({ seq: 9 }), event({ seq: 3 })],
      hasMore: true,
    });
  });

  it("an event inserts by seq, without duplicates", () => {
    const start = reduceHealth(EMPTY_HEALTH, {
      kind: "snapshot",
      events: [event({ seq: 9 }), event({ seq: 3 })],
      hasMore: false,
    });
    const inserted = reduceHealth(start, { kind: "event", event: event({ seq: 5 }) });
    expect(inserted.events.map((one) => one.seq)).toEqual([9, 5, 3]);
    const again = reduceHealth(inserted, {
      kind: "event",
      event: event({ seq: 9, ts: 1_760_000_500_000, count: 2 }),
    });
    expect(again.events.map((one) => one.seq)).toEqual([9, 5, 3]);
    expect(again.events[0]?.ts).toBe(1_760_000_000_000);
  });

  it("a collapse bumps the ts and count of its row, in place", () => {
    const start = reduceHealth(EMPTY_HEALTH, {
      kind: "snapshot",
      events: [event({ seq: 9 }), event({ seq: 3 })],
      hasMore: false,
    });
    const bumped = reduceHealth(start, { kind: "collapse", seq: 3, ts: 1_760_000_900_000, count: 7 });
    expect(bumped.events.map((one) => one.seq)).toEqual([9, 3]);
    expect(bumped.events[1]).toEqual({ ...event({ seq: 3 }), ts: 1_760_000_900_000, count: 7 });
  });

  it("garbage is skipped, never fatal", () => {
    const start = reduceHealth(EMPTY_HEALTH, {
      kind: "snapshot",
      events: [event()],
      hasMore: false,
    });
    for (const garbage of [
      "string",
      null,
      { kind: "nope" },
      { kind: "event", event: { seq: 1 } },
      { kind: "collapse" },
      { kind: "snapshot", events: [event({ severity: "att" })], hasMore: false },
    ])
      expect(reduceHealth(start, garbage)).toBe(start);
  });
});

describe("appendHealthPage", () => {
  it("merges an older page by seq and takes its hasMore", () => {
    const start = reduceHealth(EMPTY_HEALTH, {
      kind: "snapshot",
      events: [event({ seq: 9 }), event({ seq: 3 })],
      hasMore: true,
    });
    const view = appendHealthPage(start, {
      events: [event({ seq: 3, count: 4 }), event({ seq: 1 })],
      hasMore: false,
    });
    expect(view.events.map((one) => one.seq)).toEqual([9, 3, 1]);
    expect(view.events[1]?.count).toBe(1);
    expect(view.hasMore).toBe(false);
  });
});
