import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const snapshot = {
  kind: "snapshot",
  status: "idle",
  rows: [],
  dialogs: [],
  partial: null,
  queue: { steering: [], followUp: [], count: 0, bytes: 0 },
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
};
const cost = { sessionUsd: 0.42, runUsd: 0.05, billing: "api" } as const;

describe("the session cost in the view", () => {
  it("a snapshot's cost and each cost event land in view.cost; a cold status keeps it", () => {
    expect(EMPTY_VIEW.cost).toBeNull();
    const loaded = reduceSession(EMPTY_VIEW, { ...snapshot, cost });
    expect(loaded.cost).toEqual(cost);
    const next = { sessionUsd: 0.5, runUsd: null, billing: "api" } as const;
    const updated = reduceSession(loaded, { kind: "cost", cost: next });
    expect(updated.cost).toEqual(next);
    expect(reduceSession(updated, { kind: "status", status: "cold" }).cost).toEqual(next);
    expect(reduceSession(updated, snapshot).cost).toBeNull();
    expect(
      reduceSession(updated, { kind: "cost", cost: { sessionUsd: -1, runUsd: null, billing: "api" } }),
    ).toBe(updated);
  });
});
