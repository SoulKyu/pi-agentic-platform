import { PLATFORM_RESULTS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "../platform/index.ts";
import { PlatformRefusal } from "../platform/index.ts";
import { createAgentEvents } from "./events.ts";
import { createNotify, NOTIFICATIONS_PER_HOUR } from "./ops-notify.ts";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

async function setup() {
  bed = createAgentsBed();
  const { id: agentId } = await bed.agents.create(bed.owner(), agentInput());
  const bump = vi.fn();
  const upserts: Array<Record<string, unknown>> = [];
  const events = createAgentEvents({
    db: bed.db,
    clock: bed.clock,
    logger: { warn: vi.fn() },
    unread: { bump },
  });
  const notify = createNotify({
    events,
    items: {
      upsertAgentItem(input) {
        upserts.push({ ...input });
        return true;
      },
    },
    clock: bed.clock,
    logger: { warn: vi.fn() },
  });
  const ctx = (over: Partial<PlatformContext> = {}): PlatformContext => ({
    ownerId: "u1",
    sessionId: "t1",
    type: "agent-thread",
    tainted: false,
    agentId,
    signal: new AbortController().signal,
    ...over,
  });
  // The wire schema already refuses hidden characters and over-long text; the handler strips and clips anyway.
  const call = (text: string, over: Partial<PlatformContext> = {}) => notify({ text }, ctx(over));
  const cards = () =>
    bed.db.all<{ kind: string; data: string }>("SELECT kind, data FROM agent_events ORDER BY id");
  const refusal = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      return error instanceof PlatformRefusal ? error.code : `other: ${String(error)}`;
    }
    return "none";
  };
  return { agentId, bump, upserts, call, cards, refusal };
}

describe("agent.notify (M11R100)", () => {
  it("writes an info Inbox item with the stripped text, and answers with its id", async () => {
    const t = await setup();
    const result = await t.call("Build is green.\nShip it?");
    expect(PLATFORM_RESULTS["agent.notify"].parse(result)).toEqual(result);
    expect(t.upserts).toEqual([
      {
        ownerId: "u1",
        kind: "agent_notify",
        agentId: t.agentId,
        refId: result.itemId,
        detail: "Build is green. Ship it?",
        toHandle: false,
      },
    ]);
  });

  it("strips hidden characters and clips the text to 500", async () => {
    const t = await setup();
    await t.call(`Hi\u202E there${"z".repeat(600)}`);
    const detail = t.upserts[0]?.detail as string;
    expect(detail).toBe(`Hi there${"z".repeat(492)}`);
    expect([...detail]).toHaveLength(500);
  });

  it("puts the same text and the item id in a notify card of the thread, and counts it unread once", async () => {
    const t = await setup();
    const { itemId } = await t.call("Done.");
    expect(t.cards().map((card) => card.kind)).toEqual(["notify"]);
    expect(JSON.parse(t.cards()[0]?.data ?? "")).toEqual({ text: "Done.", itemId });
    expect(t.bump).toHaveBeenCalledTimes(1);
    expect(t.bump).toHaveBeenCalledWith("u1", t.agentId);
  });

  it("takes 30 an hour per agent: the 31st writes no item and no card, and an hour later it works again", async () => {
    const t = await setup();
    for (let n = 0; n < NOTIFICATIONS_PER_HOUR; n += 1) await t.call(`n${n}`);
    expect(await t.refusal(t.call("one too many"))).toBe("rate_limited");
    expect(t.upserts).toHaveLength(30);
    expect(t.cards()).toHaveLength(30);
    expect(t.bump).toHaveBeenCalledTimes(30);
    await bed.clock.advance(3_600_000);
    expect(await t.refusal(t.call("again"))).toBe("none");
    expect(t.cards()).toHaveLength(31);
  });

  it("spends no rate slot on an agent that is not the owner's", async () => {
    const t = await setup();
    for (let n = 0; n < NOTIFICATIONS_PER_HOUR + 5; n += 1)
      expect(await t.refusal(t.call("x", { ownerId: "u2" }))).toBe("not_found");
    for (let n = 0; n < NOTIFICATIONS_PER_HOUR; n += 1) expect(await t.refusal(t.call(`n${n}`))).toBe("none");
    expect(await t.refusal(t.call("one too many"))).toBe("rate_limited");
  });

  it("answers not_found for an agent that is gone or a call with no agent, and bad_request for no visible text", async () => {
    const t = await setup();
    expect(await t.refusal(t.call("x", { agentId: null }))).toBe("not_found");
    expect(await t.refusal(t.call("x", { ownerId: "u2" }))).toBe("not_found");
    expect(await t.refusal(t.call("\u200B"))).toBe("bad_request");
    expect(t.upserts).toEqual([]);
    expect(t.cards()).toEqual([]);
  });
});
