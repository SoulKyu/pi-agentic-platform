import { describe, expect, it } from "vitest";
import { SessionCost } from "./session-cost.ts";
import { SessionStreamEvent } from "./streams.ts";

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

describe("session cost contract", () => {
  it("a snapshot without cost parses with cost null", () => {
    const parsed = SessionStreamEvent.parse(snapshot);
    expect(parsed.kind === "snapshot" && parsed.cost).toBeNull();
  });

  it("a cost event parses and refuses a negative or non-finite figure", () => {
    const cost = { sessionUsd: 0.42, runUsd: 0.05, billing: "api" };
    expect(SessionStreamEvent.safeParse({ kind: "cost", cost }).success).toBe(true);
    expect(SessionCost.safeParse({ ...cost, runUsd: null, billing: "unknown" }).success).toBe(true);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2e9])
      expect(SessionCost.safeParse({ ...cost, sessionUsd: bad }).success, String(bad)).toBe(false);
    expect(SessionCost.safeParse({ ...cost, runUsd: -0.1 }).success).toBe(false);
    expect(SessionCost.safeParse({ ...cost, billing: "free" }).success).toBe(false);
  });
});
