import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const snapshot = (queue: unknown) => ({
  kind: "snapshot",
  status: "running",
  rows: [],
  dialogs: [],
  partial: null,
  queue,
  statuses: [],
  widgets: [],
  title: null,
  panels: [],
  notices: [],
  decorationsTruncated: false,
  history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
  activity: { compacting: false, retry: null },
  leafId: null,
  name: null,
});
const waiting = { steering: ["go left"], followUp: ["then this"], count: 2, bytes: 16 };
const empty = { steering: [], followUp: [], count: 0, bytes: 0 };

describe("the steering queue in the view", () => {
  it("starts empty", () => {
    expect(EMPTY_VIEW.queue).toEqual(empty);
  });

  it("takes the queue from the snapshot", () => {
    expect(reduceSession(EMPTY_VIEW, snapshot(waiting)).queue).toEqual(waiting);
  });

  it("replaces the queue on each queue event", () => {
    const view = reduceSession(reduceSession(EMPTY_VIEW, snapshot(waiting)), {
      kind: "queue",
      queue: { steering: [], followUp: ["then this"], count: 1, bytes: 9 },
    });
    expect(view.queue).toEqual({ steering: [], followUp: ["then this"], count: 1, bytes: 9 });
  });

  it("empties the queue when the session goes cold, and not for another status", () => {
    const view = reduceSession(EMPTY_VIEW, snapshot(waiting));
    expect(reduceSession(view, { kind: "status", status: "idle" }).queue).toEqual(waiting);
    expect(reduceSession(view, { kind: "status", status: "cold" }).queue).toEqual(empty);
  });

  it("ignores a queue event the contract cannot read", () => {
    const view = reduceSession(EMPTY_VIEW, snapshot(waiting));
    expect(reduceSession(view, { kind: "queue", queue: { steering: "x" } })).toBe(view);
  });
});
