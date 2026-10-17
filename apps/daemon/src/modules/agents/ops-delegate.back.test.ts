import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentEvents } from "./events.ts";
import { createDelegationBack, type DelegationEnd } from "./ops-delegate.ts";
import { type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const ATLAS = "atlas-0000";
const SCOUT = "scout-0001";

function setup(options: { scout?: boolean; inboxThrows?: boolean } = {}) {
  bed = createAgentsBed();
  const names = new Map<string, string>([[ATLAS, "Atlas"]]);
  if (options.scout !== false) names.set(SCOUT, "Scout");
  for (const [id, name] of names)
    bed.db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ($id, 'u1', $name, lower($name), '{"name":"x"}', 1, 1)`,
      { id, name },
    );
  const bump = vi.fn();
  const warn = vi.fn();
  const events = createAgentEvents({
    db: bed.db,
    clock: bed.clock,
    logger: { warn } as never,
    unread: { bump },
  });
  const upsertAgentItem = vi.fn<(input: unknown) => boolean>(() => {
    if (options.inboxThrows) throw new Error("inbox down");
    return true;
  });
  const back = createDelegationBack({
    agents: {
      get: (ownerId, id) => (ownerId === "u1" && names.has(id) ? ({ name: names.get(id) } as never) : null),
    },
    events,
    inbox: { upsertAgentItem },
    logger: { warn } as never,
  });
  return { back, bump, upsertAgentItem, warn };
}
const cards = () =>
  bed.db.all<{ agent_id: string; kind: string; task_id: string | null; data: string }>(
    "SELECT agent_id, kind, task_id, data FROM agent_events ORDER BY id",
  );
const end = (over: Partial<DelegationEnd> = {}): DelegationEnd => ({
  ownerId: "u1",
  taskId: "task-1",
  requesterId: ATLAS,
  targetId: SCOUT,
  state: "done",
  summary: "Three issues are open.\nTwo are old.",
  tainted: false,
  isolated: false,
  ...over,
});

describe("the delegation's result goes back as a card, never as a prompt (M11R79)", () => {
  it("writes the card in the requester's thread, counts it unread, and opens a delegation_done Inbox item for the owner", () => {
    const { back, bump, upsertAgentItem } = setup();
    back.back(end({ tainted: true, isolated: true }));
    const [card] = cards();
    expect(card).toMatchObject({ agent_id: ATLAS, kind: "delegation", task_id: "task-1" });
    expect(JSON.parse(card?.data ?? "")).toEqual({
      fromAgentId: SCOUT,
      fromName: "Scout",
      state: "done",
      summary: "Three issues are open.\nTwo are old.",
      clipped: false,
      tainted: true,
      isolated: true,
    });
    expect(bump).toHaveBeenCalledWith("u1", ATLAS);
    expect(upsertAgentItem).toHaveBeenCalledWith({
      ownerId: "u1",
      kind: "delegation_done",
      agentId: ATLAS,
      refId: "task-1",
      toHandle: false,
      detail: "Scout: Three issues are open.",
    });
  });

  it("says a failed delegation failed", () => {
    const { back, upsertAgentItem } = setup();
    back.back(end({ state: "failed", summary: null }));
    expect(JSON.parse(cards()[0]?.data ?? "")).toMatchObject({ state: "failed", summary: "" });
    expect(upsertAgentItem).toHaveBeenCalledWith(expect.objectContaining({ detail: "Scout (failed)" }));
  });

  it("writes nothing when the requester is gone", () => {
    const { back, upsertAgentItem } = setup();
    back.back(end({ requesterId: "ghost-0000" }));
    expect(cards()).toEqual([]);
    expect(upsertAgentItem).not.toHaveBeenCalled();
  });

  it("names a target that was deleted meanwhile with a placeholder, and still delivers", () => {
    const { back } = setup({ scout: false });
    back.back(end());
    expect(JSON.parse(cards()[0]?.data ?? "")).toMatchObject({ fromName: "?" });
  });

  it("keeps the card when the Inbox cannot take its item, and says so without the text", () => {
    const { back, warn } = setup({ inboxThrows: true });
    back.back(end({ summary: "SECRET-SUMMARY" }));
    expect(cards()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("delegation_inbox_failed", expect.anything());
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-SUMMARY");
  });

  it("writes a card for the requester of another owner's task as nothing", () => {
    const { back, upsertAgentItem } = setup();
    back.back(end({ ownerId: "u2" }));
    expect(cards()).toEqual([]);
    expect(upsertAgentItem).not.toHaveBeenCalled();
  });
});
