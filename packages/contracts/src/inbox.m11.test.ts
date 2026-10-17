import { describe, expect, it } from "vitest";
import { INBOX_KINDS, InboxItem, inboxMethods } from "./inbox.ts";

const base = {
  id: "i1",
  kind: "task_done",
  toHandle: false,
  taskId: "t1",
  sessionId: null,
  triggerName: "nightly",
  costUsd: null,
  createdAt: 1,
  readAt: null,
  resolvedAt: null,
  resolution: null,
};

describe("InboxItem agent fields", () => {
  it("parses an item without them, defaults null", () => {
    expect(InboxItem.parse(base)).toMatchObject({ agentId: null, refId: null, entryId: null, detail: null });
  });

  it("refuses a detail over 500 characters and accepts 500", () => {
    expect(InboxItem.safeParse({ ...base, detail: "x".repeat(501) }).success).toBe(false);
    expect(InboxItem.safeParse({ ...base, detail: "x".repeat(500) }).success).toBe(true);
  });

  it("stays strict", () => {
    expect(InboxItem.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe("INBOX_KINDS", () => {
  const all = Object.values(INBOX_KINDS).flat();

  it("has disjoint groups", () => {
    expect(new Set(all).size).toBe(all.length);
  });

  it("covers M10's kinds and every name fits the column", () => {
    for (const kind of ["task_needs_input", "task_done", "task_failed", "task_interrupted", "task_limited"])
      expect(all).toContain(kind);
    expect(all.every((kind) => kind.length <= 32)).toBe(true);
  });
});

describe("inbox.list filter", () => {
  const { params } = inboxMethods["inbox.list"];
  it("takes the four filters and refuses another", () => {
    for (const filter of ["all", "to_handle", "replies", "tasks"])
      expect(params.safeParse({ filter }).success).toBe(true);
    expect(params.safeParse({ filter: "info" }).success).toBe(false);
  });
});
