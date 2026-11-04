import { afterEach, describe, expect, it } from "vitest";
import { createInboxBed, type InboxBed } from "./testing/bed.ts";

let bed: InboxBed;
afterEach(() => bed.dispose());

describe("Inbox.pendingToHandle (Overview)", () => {
  it("lists the open to-handle items newest first, without resolved or other-kind items", async () => {
    bed = createInboxBed();
    for (const id of ["t1", "t2", "t3", "t4"]) bed.addTask(id);
    bed.addTask("t5", "u2");
    bed.attend("t1", true);
    await bed.clock.advance(1000);
    bed.attend("t2", true);
    bed.attend("t2", false);
    await bed.clock.advance(1000);
    bed.attend("t3", true);
    bed.move("t4", "failed");
    await bed.clock.advance(1000);
    bed.attend("t5", true);
    const items = bed.inbox.pendingToHandle("u1", 10);
    expect(items.map((item) => item.taskId)).toEqual(["t3", "t1"]);
    expect(items.every((item) => item.toHandle && item.resolvedAt === null)).toBe(true);
  });

  it("honours the limit, keeping the newest", async () => {
    bed = createInboxBed();
    for (const id of ["t1", "t2", "t3"]) {
      bed.addTask(id);
      bed.attend(id, true);
      await bed.clock.advance(1000);
    }
    expect(bed.inbox.pendingToHandle("u1", 2).map((item) => item.taskId)).toEqual(["t3", "t2"]);
    expect(bed.inbox.pendingToHandle("u1", 0)).toEqual([]);
  });
});

describe("Inbox.unresolvedRefs (Overview)", () => {
  const pause = (ownerId: string, refId: string, kind = "box_paused") =>
    bed.inbox.agentItems.upsertAgentItem({
      ownerId,
      kind,
      agentId: null,
      title: refId,
      refId,
      detail: null,
      toHandle: false,
    });

  it("lists the owner's refs of one kind, newest first, never another owner's or another kind's", async () => {
    bed = createInboxBed();
    pause("u1", "p1");
    await bed.clock.advance(1000);
    pause("u1", "p2");
    pause("u2", "p3");
    pause("u1", "p4", "agent_notify");
    expect(bed.inbox.unresolvedRefs("u1", "box_paused", 10)).toEqual(["p2", "p1"]);
    expect(bed.inbox.unresolvedRefs("u2", "box_paused", 10)).toEqual(["p3"]);
    expect(bed.inbox.unresolvedRefs("u1", "box_paused", 1)).toEqual(["p2"]);
    expect(bed.inbox.unresolvedRefs("nobody", "box_paused", 10)).toEqual([]);
  });

  it("leaves out a resolved item", () => {
    bed = createInboxBed();
    pause("u1", "p1");
    bed.inbox.agentItems.resolveRef("u1", "box_paused", "p1", null);
    expect(bed.inbox.unresolvedRefs("u1", "box_paused", 10)).toEqual([]);
  });
});
