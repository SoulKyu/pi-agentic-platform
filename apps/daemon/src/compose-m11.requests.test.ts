import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "./testing/caller.ts";
import { disposeParts, parts } from "./testing/compose-m11-parts.ts";

afterEach(disposeParts);

describe("agent.notify, agent.approve and the requests (Task 17)", () => {
  const insertAgent = (db: ReturnType<typeof parts>["db"]) =>
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
  const platformOf = (sessions: ReturnType<typeof parts>["sessions"]) =>
    (
      sessions.setAgentPorts.mock.calls[0]?.[0] as {
        platform: import("./modules/platform/index.ts").PlatformPort;
      }
    ).platform;

  it("notify writes the Inbox item and the thread card; the agent_reply item follows the unread count", async () => {
    const { sessions, db, agentItems, m11, clock } = parts();
    insertAgent(db);
    const replies: Array<{ ok: boolean; result?: { itemId: string } }> = [];
    platformOf(sessions).onRecord(
      { id: "s1", ownerId: "u1" },
      { type: "platform_call", id: "p1", op: "agent.notify", toolCallId: "t", args: { text: "Done." } },
      (record) => replies.push(record as never),
    );
    await clock.advance(0);
    const itemId = replies[0]?.result?.itemId;
    expect(replies[0]?.ok).toBe(true);
    expect(agentItems.upsertAgentItem).toHaveBeenCalledWith({
      ownerId: "u1",
      kind: "agent_notify",
      agentId: "atlas-0001",
      refId: itemId,
      detail: "Done.",
      toHandle: false,
    });
    expect(agentItems.upsertAgentItem).toHaveBeenCalledWith({
      ownerId: "u1",
      kind: "agent_reply",
      agentId: "atlas-0001",
      refId: "atlas-0001",
      toHandle: false,
    });
    expect(db.all("SELECT kind FROM agent_events")).toEqual([{ kind: "notify" }]);
    expect(m11.agents.get("u1", "atlas-0001")?.unread).toBe(1);
  });

  it("approve opens a request that the owner answers through agents.answerApproval; a token cannot", async () => {
    const { sessions, db, m11, agentItems, clock, hub } = parts();
    insertAgent(db);
    const replies: unknown[] = [];
    platformOf(sessions).onRecord(
      { id: "s1", ownerId: "u1" },
      { type: "platform_call", id: "p1", op: "agent.approve", toolCallId: "t", args: { title: "Go?" } },
      (record) => replies.push(record),
    );
    await clock.advance(0);
    const row = db.get<{ id: string }>("SELECT id FROM agent_requests WHERE state = 'pending'");
    expect(agentItems.upsertAgentItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent_approve", refId: row?.id, toHandle: true }),
    );
    expect(hub.publish).toHaveBeenCalledWith(
      "agents",
      "u1",
      expect.objectContaining({
        kind: "request",
        request: expect.objectContaining({
          id: row?.id,
          agentId: "atlas-0001",
          kind: "approve",
          title: "Go?",
        }),
      }),
    );
    const token = { caller: testCaller({ kind: "token" }) } as never;
    await expect(
      m11.rpc["agents.answerApproval"]({ requestId: row?.id ?? "", approved: true }, token),
    ).rejects.toMatchObject({ code: "forbidden" });
    await m11.rpc["agents.answerApproval"]({ requestId: row?.id ?? "", approved: true }, {
      caller: testCaller(),
    } as never);
    await clock.advance(0);
    expect(replies).toEqual([{ type: "platform_result", id: "p1", ok: true, result: { approved: true } }]);
    expect(agentItems.resolveRef).toHaveBeenCalledWith("u1", "agent_approve", row?.id, "answered");
    expect(hub.publish).toHaveBeenCalledWith("agents", "u1", { kind: "request_closed", id: row?.id });
  });
});
