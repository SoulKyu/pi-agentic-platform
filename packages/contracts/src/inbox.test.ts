import { describe, expect, it } from "vitest";
import { INBOX_LIMITS, InboxItem, InboxStreamEvent, methods, STREAMS, TOKEN_PERMISSIONS } from "./index.ts";

const item = {
  id: "i1",
  kind: "task_done",
  toHandle: false,
  taskId: "t1",
  sessionId: "s1",
  triggerName: "prod-alerts",
  costUsd: 0.12,
  createdAt: 5,
  readAt: null,
  resolvedAt: null,
  resolution: null,
};

describe("the Inbox contract", () => {
  it("adds the inbox stream", () => {
    expect(STREAMS).toContain("inbox");
  });

  it("declares markRead as an inbox:operate mutation a token may call, and list and the stream as reads", () => {
    expect(methods["inbox.markRead"]).toMatchObject({ permission: "inbox:operate", idempotent: false });
    expect(methods["inbox.list"]).toMatchObject({ permission: "inbox:read", idempotent: true });
    expect(methods["subscribe.inbox"]).toMatchObject({ permission: "inbox:read", idempotent: true });
    expect(TOKEN_PERMISSIONS).toContain("inbox:operate");
  });

  it("reads the three stream events and refuses a resolution that is not one of the two", () => {
    expect(InboxItem.safeParse(item).success).toBe(true);
    expect(InboxItem.safeParse({ ...item, resolution: "ignored" }).success).toBe(false);
    for (const event of [
      { kind: "snapshot", items: [item], unread: 1, toHandle: 0, truncated: false },
      { kind: "item", item },
      { kind: "counts", unread: 0, toHandle: 0 },
    ])
      expect(InboxStreamEvent.safeParse(event).success).toBe(true);
    expect(InboxStreamEvent.safeParse({ kind: "other" }).success).toBe(false);
  });

  it("takes ids (at most 200) or all, never both and never neither", () => {
    const params = methods["inbox.markRead"].params;
    expect(params.safeParse({ ids: ["a"] }).success).toBe(true);
    expect(params.safeParse({ all: true }).success).toBe(true);
    expect(params.safeParse({}).success).toBe(false);
    expect(params.safeParse({ ids: ["a"], all: true }).success).toBe(false);
    const many = (count: number) => Array.from({ length: count }, (_, index) => `i${index}`);
    expect(params.safeParse({ ids: many(INBOX_LIMITS.markReadIds) }).success).toBe(true);
    expect(params.safeParse({ ids: many(INBOX_LIMITS.markReadIds + 1) }).success).toBe(false);
  });
});
