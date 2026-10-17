import { AgentInput, type PlatformResultRecord } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformPort } from "./modules/platform/index.ts";
import { testCaller } from "./testing/caller.ts";
import { disposeParts, parts } from "./testing/compose-m11-parts.ts";

afterEach(disposeParts);

const ATLAS = "atlas-0001";
const SCOUT = "scout-0002";
type Parts = ReturnType<typeof parts>;

function insertAgent(world: Parts, id: string, name: string, accepts = true): void {
  world.db.run(
    `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
     VALUES ($id, 'u1', $name, lower($name), $profile, 1, 1)`,
    { id, name, profile: JSON.stringify(AgentInput.parse({ name, acceptsDelegation: accepts })) },
  );
}
const platformOf = (world: Parts) =>
  (world.sessions.setAgentPorts.mock.calls[0]?.[0] as unknown as { platform: PlatformPort }).platform;

async function call(world: Parts, op: "agent.delegate" | "agent.remind", args: object, toolCallId = "tc1") {
  const replies: PlatformResultRecord[] = [];
  platformOf(world).onRecord(
    { id: "s1", ownerId: "u1" },
    { type: "platform_call", id: `p-${replies.length}`, op, toolCallId, args } as never,
    (record) => replies.push(record),
  );
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  return replies[0] as PlatformResultRecord;
}
const ctxFor = (world: Parts) =>
  ({ caller: testCaller({ stepUpUntil: world.clock.now() + 60_000 }), openSubscription: vi.fn() }) as never;

describe("agent.delegate and agent.remind on the platform (Task 12)", () => {
  it("registers both ops: a worker of an agent thread is offered them", () => {
    const world = parts();
    expect(platformOf(world).available("agent.delegate", "u1")).toBe(true);
    expect(platformOf(world).available("agent.remind", "u1")).toBe(true);
  });

  it("an untainted agent delegates to an opted-in agent by name: a thread task, the id back", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    insertAgent(world, SCOUT, "Scout");
    expect(await call(world, "agent.delegate", { agent: "scout", task: "Summarise" })).toMatchObject({
      ok: true,
      result: { taskId: "delegated-1" },
    });
    expect(world.agentTasks.delegate).toHaveBeenCalledWith({
      ownerId: "u1",
      requesterId: ATLAS,
      targetId: SCOUT,
      text: "Summarise",
      isolated: false,
    });
  });

  it("refuses an agent that did not opt in, and itself", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    insertAgent(world, SCOUT, "Scout", false);
    expect(await call(world, "agent.delegate", { agent: "Scout", task: "x" })).toMatchObject({
      ok: false,
      error: "refused",
    });
    expect(await call(world, "agent.delegate", { agent: "Atlas", task: "x" })).toMatchObject({
      ok: false,
      error: "refused",
    });
    expect(world.agentTasks.delegate).not.toHaveBeenCalled();
  });

  it("a tainted caller that the owner did not answer gets nothing; one the owner allowed once makes an isolated task", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    insertAgent(world, SCOUT, "Scout");
    world.sessions.kindOf.mockReturnValue({
      ownerId: "u1",
      type: "agent-thread",
      tainted: true,
      agentId: ATLAS,
    });
    expect(await call(world, "agent.delegate", { agent: "Scout", task: "x" })).toMatchObject({
      ok: false,
      error: "tainted",
    });
    expect(world.agentTasks.delegate).not.toHaveBeenCalled();
    world.sessions.approvedCalls.take.mockReturnValueOnce(true);
    expect(await call(world, "agent.delegate", { agent: "Scout", task: "x" }, "tc2")).toMatchObject({
      ok: true,
    });
    expect(world.sessions.approvedCalls.take).toHaveBeenCalledWith("s1", "tc2", "agent_delegate");
    expect(world.agentTasks.delegate).toHaveBeenCalledWith(expect.objectContaining({ isolated: true }));
  });

  it("a reminder is a task for the agent itself; the tainted one waits for the owner's answer too", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    const reply = await call(world, "agent.remind", { when: "2h", note: "Check the build" });
    expect(reply).toMatchObject({ ok: true, result: { taskId: "reminder-1" } });
    expect(world.agentTasks.remind).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "u1",
        agentId: ATLAS,
        note: "Check the build",
        notBefore: world.clock.now() + 2 * 3_600_000,
        requestedBy: null,
        tainted: false,
      }),
    );
    world.sessions.kindOf.mockReturnValue({
      ownerId: "u1",
      type: "agent-thread",
      tainted: true,
      agentId: ATLAS,
    });
    expect(await call(world, "agent.remind", { when: "2h", note: "x" }, "tc2")).toMatchObject({
      ok: false,
      error: "tainted",
    });
    expect(world.agentTasks.remind).toHaveBeenCalledTimes(1);
  });

  it("refuses an unreadable time with the same code whatever it says", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    for (const when of ["tomorrow", "10s", "2026-10-17T09:00:00"])
      expect(await call(world, "agent.remind", { when, note: "x" })).toMatchObject({
        ok: false,
        error: "bad_request",
      });
    expect(world.agentTasks.remind).not.toHaveBeenCalled();
  });
});

describe("the result of a delegation (M11R79)", () => {
  const backOf = (world: Parts) =>
    (
      world.automationModule.bindAgents.mock.calls[0]?.[0] as unknown as {
        delegations: { back(end: object): void };
      }
    ).delegations.back;
  const end = (over: object = {}) => ({
    ownerId: "u1",
    taskId: "task-9",
    requesterId: ATLAS,
    targetId: SCOUT,
    state: "done",
    summary: "Three issues are open.",
    tainted: false,
    isolated: false,
    ...over,
  });

  it("writes a card in the requester's thread, counts it unread, and opens a delegation_done reply for the owner", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    insertAgent(world, SCOUT, "Scout");
    backOf(world)(end({ isolated: true, tainted: true }));
    const page = await world.m11.rpc["agents.events"]({ agentId: ATLAS }, ctxFor(world));
    expect(page.events).toMatchObject([
      {
        kind: "delegation",
        taskId: "task-9",
        data: { fromAgentId: SCOUT, fromName: "Scout", state: "done", isolated: true, tainted: true },
      },
    ]);
    expect(world.m11.agents.get("u1", ATLAS)?.unread).toBe(1);
    expect(world.m11.agents.get("u1", SCOUT)?.unread).toBe(0);
    // The unread card also raises the agent's reply item (Task 17); the delegation's own item is the one read here.
    const replies = world.inbox.list("u1", undefined, "replies").items;
    expect(replies.map((item) => item.kind).sort()).toEqual(["agent_reply", "delegation_done"]);
    expect(replies.filter((item) => item.kind === "delegation_done")).toMatchObject([
      { kind: "delegation_done", agentId: ATLAS, refId: "task-9", detail: "Scout: Three issues are open." },
    ]);
  });
});

describe("the agent's Inbox items (carry 2)", () => {
  const put = (world: Parts, agentId: string, kind: string, refId: string, toHandle = false) =>
    world.inbox.agentItems.upsertAgentItem({ ownerId: "u1", kind, agentId, refId, toHandle });
  const kinds = (world: Parts) =>
    world.db
      .all<{ agent_id: string; kind: string; ref_id: string }>(
        "SELECT agent_id, kind, ref_id FROM inbox_items ORDER BY agent_id, kind, ref_id",
      )
      .map((item) => `${item.agent_id}:${item.kind}:${item.ref_id}`);

  it("deleting an agent drops its reply, its notifications and a resolved item, and no other agent's", async () => {
    const world = parts({ busy: false });
    insertAgent(world, ATLAS, "Atlas");
    insertAgent(world, SCOUT, "Scout");
    put(world, ATLAS, "agent_reply", ATLAS);
    put(world, ATLAS, "agent_notify", "n1");
    put(world, ATLAS, "agent_notify", "n2");
    put(world, ATLAS, "agent_approve", "q1", true);
    world.inbox.agentItems.resolveRef("u1", "agent_approve", "q1", "answered");
    put(world, SCOUT, "agent_reply", SCOUT);
    put(world, SCOUT, "agent_notify", "n3");
    expect(kinds(world)).toHaveLength(6);

    await world.m11.rpc["agents.delete"]({ agentId: ATLAS }, ctxFor(world));

    expect(world.m11.agents.get("u1", ATLAS)).toBeNull();
    expect(kinds(world)).toEqual([`${SCOUT}:agent_notify:n3`, `${SCOUT}:agent_reply:${SCOUT}`]);
  });

  it("keeps the items of an agent whose delete was refused", async () => {
    const world = parts({ busy: true });
    insertAgent(world, ATLAS, "Atlas");
    put(world, ATLAS, "agent_notify", "n1");
    await expect(world.m11.rpc["agents.delete"]({ agentId: ATLAS }, ctxFor(world))).rejects.toMatchObject({
      code: "session_busy",
    });
    expect(kinds(world)).toEqual([`${ATLAS}:agent_notify:n1`]);
  });

  it("a delete still succeeds when the Inbox cannot drop the items, and says so", async () => {
    const world = parts({ busy: false });
    insertAgent(world, ATLAS, "Atlas");
    vi.spyOn(world.inbox.agentItems, "removeAgentItems").mockImplementation(() => {
      throw new Error("inbox down");
    });
    await world.m11.rpc["agents.delete"]({ agentId: ATLAS }, ctxFor(world));
    expect(world.m11.agents.get("u1", ATLAS)).toBeNull();
  });

  it("a reset of the thread closes the agent's agent_reply item", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    put(world, ATLAS, "agent_reply", ATLAS);
    await world.m11.rpc["agents.openThread"]({ agentId: ATLAS }, ctxFor(world));
    await world.m11.rpc["agents.resetThread"]({ agentId: ATLAS }, ctxFor(world));
    expect(
      world.db.get<{ resolved_at: number | null }>("SELECT resolved_at FROM inbox_items")?.resolved_at,
    ).toBe(world.clock.now());
  });

  it("a reset and a mark-read both drop the owner's unread count (W5-R48)", async () => {
    const world = parts();
    insertAgent(world, ATLAS, "Atlas");
    put(world, ATLAS, "agent_reply", ATLAS);
    expect(world.inbox.snapshot("u1").unread).toBe(1);
    await world.m11.rpc["agents.openThread"]({ agentId: ATLAS }, ctxFor(world));
    await world.m11.rpc["agents.resetThread"]({ agentId: ATLAS }, ctxFor(world));
    expect(world.inbox.snapshot("u1").unread).toBe(0);
    put(world, ATLAS, "agent_reply", ATLAS);
    expect(world.inbox.snapshot("u1").unread).toBe(1);
    await world.m11.rpc["agents.markRead"]({ agentId: ATLAS }, ctxFor(world));
    expect(world.inbox.snapshot("u1").unread).toBe(0);
  });
});
