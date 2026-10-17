import { INBOX_LIMITS } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createInboxStore } from "./store.ts";
import { createInboxBed, type InboxBed } from "./testing/bed.ts";

let bed: InboxBed;
afterEach(() => bed.dispose());

const AGENT = "agent-1";
const ask = (overrides: Record<string, unknown> = {}) => ({
  ownerId: "u1",
  kind: "agent_approve",
  agentId: AGENT,
  refId: "req-1",
  toHandle: true,
  ...overrides,
});
const agentRows = () => bed.rows().filter((row) => row["ref_id"] !== null);

describe("upsertAgentItem", () => {
  it("writes one row per (ref, kind) and reopens a resolved one", async () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask({ entryId: "e1", detail: "first" }));
    bed.inbox.agentItems.resolveRef("u1", "agent_approve", "req-1", "answered");
    expect(agentRows()[0]).toMatchObject({ resolved_at: bed.clock.now(), resolution: "answered" });
    await bed.clock.advance(5000);
    bed.inbox.agentItems.upsertAgentItem(ask({ entryId: "e2", detail: "again" }));
    expect(agentRows()).toHaveLength(1);
    expect(agentRows()[0]).toMatchObject({
      resolved_at: null,
      resolution: null,
      read_at: null,
      entry_id: "e2",
      detail: "again",
      agent_id: AGENT,
      created_at: bed.clock.now(),
    });
  });

  it("shows the item on the stream with its agent fields and counts it to handle", () => {
    bed = createInboxBed();
    const frames = bed.open("u1");
    bed.inbox.agentItems.upsertAgentItem(ask({ entryId: "e1", detail: "d" }));
    expect(bed.inbox.snapshot("u1").toHandle).toBe(1);
    expect(frames.some((frame) => JSON.stringify(frame).includes('"agentId":"agent-1"'))).toBe(true);
  });

  it("stores detail without hidden characters, clipped at 500 without splitting a pair", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask({ detail: "ok\u202Eevil\u200B\u0007 line\u2028" }));
    expect(agentRows()[0]?.["detail"]).toBe("okevil line");
    bed.inbox.agentItems.upsertAgentItem(ask({ refId: "req-2", detail: `${"a".repeat(499)}\u{1F600}more` }));
    const clipped = bed.db.get<{ detail: string }>("SELECT detail FROM inbox_items WHERE ref_id = 'req-2'");
    expect(clipped?.detail).toBe("a".repeat(499));
  });

  it("keeps detail on one line: newlines and tabs collapse, a ZWJ emoji stays whole", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask({ detail: "first\nsecond\t\tthird\r\n\r\nfourth" }));
    expect(agentRows()[0]?.["detail"]).toBe("first second third fourth");
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    bed.inbox.agentItems.upsertAgentItem(ask({ refId: "req-2", detail: `a ${family} b` }));
    const kept = bed.db.get<{ detail: string }>("SELECT detail FROM inbox_items WHERE ref_id = 'req-2'");
    expect(kept?.detail).toBe(`a ${family} b`);
  });

  it("stores 500 UTF-16 units at most even when 500 code points would be more", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask({ detail: "\u{1F600}".repeat(400) }));
    expect(agentRows()[0]?.["detail"]).toBe("\u{1F600}".repeat(250));
  });

  it("stores no detail when nothing visible is left", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask({ detail: "\u202E\u200B" }));
    expect(agentRows()[0]?.["detail"]).toBeNull();
    bed.inbox.agentItems.upsertAgentItem(ask({ refId: "req-2", detail: " \n\t \u200D " }));
    const blank = bed.db.get<{ detail: string | null }>(
      "SELECT detail FROM inbox_items WHERE ref_id = 'req-2'",
    );
    expect(blank?.detail).toBeNull();
  });

  it("keeps the fixed label 'agent' in the title column, and the id in agentId", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask());
    expect(agentRows()[0]).toMatchObject({ title: "agent", agent_id: AGENT });
    expect(bed.inbox.list("u1", undefined, "all").items[0]).toMatchObject({
      triggerName: "agent",
      agentId: AGENT,
    });
  });

  it("answers whether the write happened: false for a refused collision, true otherwise", () => {
    bed = createInboxBed();
    expect(bed.inbox.agentItems.upsertAgentItem(ask())).toBe(true);
    expect(bed.inbox.agentItems.upsertAgentItem(ask({ ownerId: "u2", agentId: "agent-2" }))).toBe(false);
    expect(bed.inbox.agentItems.upsertAgentItem(ask())).toBe(true);
  });

  it.each([
    ["an empty refId", { refId: "" }],
    ["a refId of 129 characters", { refId: "r".repeat(129) }],
    ["an entryId of 129 characters", { entryId: "e".repeat(129) }],
    ["an agentId of 5 characters", { agentId: "abcde" }],
    ["an agentId of 49 characters", { agentId: "a".repeat(49) }],
  ])("refuses %s before SQL: nothing is written, one line is logged, nothing throws", (_name, overrides) => {
    bed = createInboxBed();
    bed.logs.length = 0;
    expect(bed.inbox.agentItems.upsertAgentItem(ask(overrides))).toBe(false);
    expect(agentRows()).toHaveLength(0);
    expect(bed.logs.filter((line) => line["msg"] === "inbox_agent_item_refused")).toHaveLength(1);
  });

  it("accepts the limits themselves: refId 128, entryId 128, agentId 6 and 48", () => {
    bed = createInboxBed();
    const { agentItems } = bed.inbox;
    expect(agentItems.upsertAgentItem(ask({ refId: "r".repeat(128), entryId: "e".repeat(128) }))).toBe(true);
    expect(agentItems.upsertAgentItem(ask({ refId: "a", agentId: "abcdef" }))).toBe(true);
    expect(agentItems.upsertAgentItem(ask({ refId: "b", agentId: "a".repeat(48) }))).toBe(true);
  });

  it("never touches another owner's row with the same ref and kind", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask({ detail: "mine" }));
    bed.inbox.agentItems.resolveRef("u1", "agent_approve", "req-1", "answered");
    const before = agentRows()[0];
    bed.logs.length = 0;
    bed.inbox.agentItems.upsertAgentItem(ask({ ownerId: "u2", agentId: "agent-2", detail: "theirs" }));
    expect(agentRows()).toEqual([before]);
    expect(bed.logs.some((line) => line["msg"] === "inbox_agent_item_refused")).toBe(true);
    expect(bed.inbox.agentItems.resolveRef("u2", "agent_approve", "req-1", "answered")).toBe(false);
    bed.inbox.agentItems.removeRef("u2", "agent_approve", "req-1");
    expect(agentRows()).toEqual([before]);
  });

  it("always writes a to-handle item at the cap, and skips an info item that cannot evict", () => {
    bed = createInboxBed();
    bed.seed("u1", INBOX_LIMITS.perOwner, { kind: "task_needs_input", toHandle: true });
    bed.inbox.agentItems.upsertAgentItem(ask({ refId: "ask" }));
    expect(bed.inbox.snapshot("u1").toHandle).toBe(INBOX_LIMITS.perOwner + 1);
    bed.inbox.agentItems.upsertAgentItem(ask({ kind: "agent_notify", refId: "note", toHandle: false }));
    expect(bed.rows().some((row) => row["ref_id"] === "note")).toBe(false);
  });

  it("evicts the oldest read info item for a new info item at the cap", () => {
    bed = createInboxBed();
    bed.seed("u1", INBOX_LIMITS.perOwner, { kind: "task_done", read: true });
    bed.inbox.agentItems.upsertAgentItem(ask({ kind: "agent_notify", refId: "note", toHandle: false }));
    expect(bed.rows().some((row) => row["ref_id"] === "note")).toBe(true);
    expect(bed.rows()).toHaveLength(INBOX_LIMITS.perOwner);
  });
});

describe("agent_reply", () => {
  it("is one per agent: raised when unread rises, resolved by mark-read", () => {
    bed = createInboxBed();
    const { agentItems } = bed.inbox;
    const reply = { kind: "agent_reply", refId: AGENT, toHandle: false, entryId: "e9" };
    agentItems.upsertAgentItem(ask(reply));
    agentItems.upsertAgentItem(ask({ ...reply, entryId: "e10" }));
    expect(agentRows()).toHaveLength(1);
    expect(bed.inbox.snapshot("u1").unread).toBe(1);
    bed.inbox.markRead("u1", { all: true });
    agentItems.resolveRef("u1", "agent_reply", AGENT, null);
    expect(agentRows()[0]).toMatchObject({ resolved_at: bed.clock.now(), resolution: null });
    agentItems.upsertAgentItem(ask(reply));
    expect(agentRows()[0]).toMatchObject({ resolved_at: null, read_at: null });
  });

  it("closing the reply marks it read as well, so the badge clears; the next unread rise reopens it (W5-R48)", () => {
    bed = createInboxBed();
    const { agentItems } = bed.inbox;
    const reply = { kind: "agent_reply", refId: AGENT, toHandle: false };
    const counts = bed.open("u1");
    agentItems.upsertAgentItem(ask(reply));
    expect(bed.inbox.snapshot("u1").unread).toBe(1);
    agentItems.resolveRef("u1", "agent_reply", AGENT, null);
    expect(bed.inbox.snapshot("u1").unread).toBe(0);
    expect(agentRows()[0]).toMatchObject({ resolved_at: bed.clock.now(), read_at: bed.clock.now() });
    const last = counts.map((frame) => frame.event as { kind: string; unread?: number }).at(-1);
    expect(last).toMatchObject({ kind: "counts", unread: 0 });
    agentItems.upsertAgentItem(ask(reply));
    expect(bed.inbox.snapshot("u1").unread).toBe(1);
    expect(agentRows()[0]).toMatchObject({ resolved_at: null, read_at: null });
  });

  it("closing a to-handle item does not mark it read (M10's behaviour)", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask());
    bed.inbox.agentItems.resolveRef("u1", "agent_approve", "req-1", "answered");
    expect(agentRows()[0]).toMatchObject({ resolution: "answered", read_at: null });
  });

  it("removeRef deletes the row", () => {
    bed = createInboxBed();
    bed.inbox.agentItems.upsertAgentItem(ask({ kind: "agent_reply", refId: AGENT, toHandle: false }));
    bed.inbox.agentItems.removeRef("u1", "agent_reply", AGENT);
    expect(agentRows()).toHaveLength(0);
  });
});

describe("inbox.list filters", () => {
  it("replies returns only replies; to_handle and tasks their own groups; all everything", () => {
    bed = createInboxBed();
    const { agentItems } = bed.inbox;
    agentItems.upsertAgentItem(ask({ kind: "agent_reply", refId: AGENT, toHandle: false }));
    agentItems.upsertAgentItem(ask({ kind: "delegation_done", refId: "d1", toHandle: false }));
    agentItems.upsertAgentItem(ask({ kind: "task_done", refId: "t-agent", toHandle: false }));
    agentItems.upsertAgentItem(ask({ kind: "agent_notify", refId: "n1", toHandle: false }));
    agentItems.upsertAgentItem(ask());
    bed.seed("u1", 1, { kind: "future_kind" });
    const kinds = (filter?: "all" | "to_handle" | "replies" | "tasks") =>
      bed.inbox
        .list("u1", undefined, filter)
        .items.map((item) => item.kind)
        .sort();
    expect(kinds("replies")).toEqual(["agent_reply", "delegation_done"]);
    expect(kinds("to_handle")).toEqual(["agent_approve"]);
    expect(kinds("tasks")).toEqual(["task_done"]);
    expect(kinds("all")).toHaveLength(6);
    expect(kinds()).toHaveLength(6);
  });

  it("pages a filtered list with hasMore", () => {
    bed = createInboxBed();
    bed.seed("u1", INBOX_LIMITS.page + 1, { kind: "agent_reply", at: 1000 });
    bed.seed("u1", 3, { kind: "task_done", at: 5000 });
    const page = bed.inbox.list("u1", undefined, "replies");
    expect(page.items).toHaveLength(INBOX_LIMITS.page);
    expect(page.hasMore).toBe(true);
  });
});

describe("the store's owner guard", () => {
  const refItem = (ownerId: string, detail: string) => ({
    id: `id-${ownerId}`,
    ownerId,
    kind: "agent_approve",
    toHandle: true,
    agentId: `agent-${ownerId}`,
    refId: "req-1",
    entryId: null,
    detail,
    at: 10,
  });

  it("upsertRef with a foreign owner returns null and leaves the first owner's row untouched", () => {
    bed = createInboxBed();
    const store = createInboxStore(bed.db);
    expect(store.upsertRef(refItem("u1", "mine"))).not.toBeNull();
    const before = agentRows();
    expect(store.upsertRef({ ...refItem("u2", "theirs"), at: 99 })).toBeNull();
    expect(agentRows()).toEqual(before);
  });

  it("can be destructured: upsertRef does not depend on its receiver", () => {
    bed = createInboxBed();
    const { upsertRef } = createInboxStore(bed.db);
    expect(upsertRef(refItem("u1", "mine"))).toMatchObject({ refId: "req-1", detail: "mine" });
  });
});

describe("an M10 task item of an agent's task", () => {
  it("carries agent_id through the existing writer and shows under Tasks", () => {
    bed = createInboxBed();
    const store = createInboxStore(bed.db);
    store.insertInfo({
      id: "x1",
      ownerId: "u1",
      kind: "task_done",
      toHandle: false,
      taskId: "t1",
      sessionId: null,
      triggerName: "nightly",
      costUsd: null,
      at: 10,
      agentId: AGENT,
    });
    const items = bed.inbox.list("u1", undefined, "tasks").items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ taskId: "t1", agentId: AGENT, refId: null, detail: null });
  });
});
