import { describe, expect, it } from "vitest";
import { slimEntryRef, summaryRow } from "./entry-events.ts";

describe("slimEntryRef", () => {
  it("keeps what the client contract carries, and nothing else", () => {
    expect(
      slimEntryRef({
        id: "e1",
        parentId: "e0",
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "toolResult",
        toolCallId: "call-1",
        messageTimestamp: 7,
        summary: "not for the wire",
      }),
    ).toEqual({
      id: "e1",
      parentId: "e0",
      type: "message",
      role: "toolResult",
      toolCallId: "call-1",
      messageTimestamp: 7,
    });
    expect(slimEntryRef({ id: "e1", parentId: null, type: "compaction" })).toEqual({
      id: "e1",
      parentId: null,
      type: "compaction",
    });
  });

  it("refuses what is malformed or does not fit the contract, never throws", () => {
    for (const raw of [
      null,
      "e1",
      {},
      { id: 7, parentId: null, type: "message" },
      { id: "", parentId: null, type: "message" },
      { id: "x".repeat(129), parentId: null, type: "message" },
      { id: "e1", parentId: "p".repeat(129), type: "message" },
      { id: "e1", parentId: null },
    ]) {
      expect(slimEntryRef(raw)).toBeNull();
    }
    expect(slimEntryRef({ id: "x".repeat(128), parentId: null, type: "message" })).not.toBeNull();
  });
});

describe("summaryRow", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  it("builds the message Pi's own conversion gives for a compaction and a branch summary", () => {
    expect(summaryRow({ type: "compaction", summary: "s", tokensBefore: 99, timestamp })).toEqual({
      role: "compactionSummary",
      summary: "s",
      tokensBefore: 99,
      timestamp: Date.parse(timestamp),
    });
    expect(summaryRow({ type: "branch_summary", summary: "b", fromId: "e3", timestamp })).toEqual({
      role: "branchSummary",
      summary: "b",
      fromId: "e3",
      timestamp: Date.parse(timestamp),
    });
  });

  it("is null for anything else, and for a branch summary with no text (Pi shows none)", () => {
    expect(summaryRow({ type: "message", timestamp })).toBeNull();
    expect(summaryRow({ type: "branch_summary", summary: "", fromId: "e3", timestamp })).toBeNull();
    expect(summaryRow(null)).toBeNull();
    expect(summaryRow({ type: "compaction", summary: 4, timestamp })).toBeNull();
  });

  it("bounds what it takes from a worker: a missing number is 0, a bad date is 0, an odd fromId is null", () => {
    expect(summaryRow({ type: "compaction", summary: "s", timestamp: "not a date" })).toEqual({
      role: "compactionSummary",
      summary: "s",
      tokensBefore: 0,
      timestamp: 0,
    });
    expect(summaryRow({ type: "branch_summary", summary: "b", fromId: 5, timestamp })).toMatchObject({
      fromId: null,
    });
    expect(
      summaryRow({ type: "branch_summary", summary: "b", fromId: "f".repeat(129), timestamp }),
    ).toMatchObject({ fromId: null });
  });
});
