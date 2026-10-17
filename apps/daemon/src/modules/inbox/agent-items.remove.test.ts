import { afterEach, describe, expect, it } from "vitest";
import { createInboxBed, type InboxBed } from "./testing/bed.ts";

let bed: InboxBed;
afterEach(() => bed.dispose());

const ATLAS = "atlas-1a2b";
const SCOUT = "scout-3c4d";
const put = (agentId: string, kind: string, refId: string, toHandle = false, ownerId = "u1") =>
  bed.inbox.agentItems.upsertAgentItem({ ownerId, kind, agentId, refId, toHandle });
const left = () =>
  bed.rows().map((row) => `${String(row["agent_id"])}:${String(row["kind"])}:${String(row["ref_id"])}`);

describe("removeAgentItems (an agent was deleted)", () => {
  it("drops every item the agent carries: a reply, two notifications, a resolved question, a task's item", () => {
    bed = createInboxBed();
    put(ATLAS, "agent_reply", ATLAS);
    put(ATLAS, "agent_notify", "n1");
    put(ATLAS, "agent_notify", "n2");
    put(ATLAS, "agent_approve", "q1", true);
    bed.inbox.agentItems.resolveRef("u1", "agent_approve", "q1", "answered");
    bed.addTask("t1", "u1", "Atlas nightly", "s-t1", ATLAS);
    bed.move("t1", "done");
    put(SCOUT, "agent_reply", SCOUT);
    put(SCOUT, "agent_notify", "n3");
    bed.addTask("t2", "u1", "prod-alerts");
    bed.move("t2", "done");
    expect(bed.rows()).toHaveLength(8);

    bed.inbox.agentItems.removeAgentItems("u1", ATLAS);

    expect(left().sort()).toEqual(
      [`${SCOUT}:agent_notify:n3`, `${SCOUT}:agent_reply:${SCOUT}`, "null:task_done:null"].sort(),
    );
  });

  it("leaves another owner's items alone, even for the same agent id", () => {
    bed = createInboxBed();
    put(ATLAS, "agent_notify", "n1");
    put(ATLAS, "agent_notify", "n2", false, "u2");
    bed.inbox.agentItems.removeAgentItems("u1", ATLAS);
    expect(bed.rows().map((row) => row["owner_id"])).toEqual(["u2"]);
  });

  it("tells the owner's badges once, and says nothing when there was nothing to drop", () => {
    bed = createInboxBed();
    put(ATLAS, "agent_approve", "q1", true);
    const frames = bed.open("u1");
    frames.length = 0;
    bed.inbox.agentItems.removeAgentItems("u1", ATLAS);
    expect(
      frames.map((frame) => JSON.stringify(frame)).filter((text) => text.includes('"counts"')),
    ).toHaveLength(1);
    expect(bed.inbox.snapshot("u1").toHandle).toBe(0);
    frames.length = 0;
    bed.inbox.agentItems.removeAgentItems("u1", ATLAS);
    expect(frames).toEqual([]);
  });
});
