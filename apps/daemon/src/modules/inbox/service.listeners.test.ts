import { afterEach, describe, expect, it } from "vitest";
import type { InboxItemEvent } from "./service.ts";
import { createInboxBed, type InboxBed } from "./testing/bed.ts";

const AGENT = "atlas-1a2b";
let bed: InboxBed;
afterEach(() => bed.dispose());

function listen(): InboxItemEvent[] {
  const heard: InboxItemEvent[] = [];
  bed.inbox.onItem((event) => void heard.push(event));
  return heard;
}
const summary = (heard: readonly InboxItemEvent[]) =>
  heard.map((event) => `${event.item.kind}:${event.change}`);

describe("Inbox.onItem (M12R22)", () => {
  it("reports a question created, answered, then reopened on the same row", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    const heard = listen();
    bed.attend("t1", true);
    const id = heard[0]?.item.id;
    bed.attend("t1", false);
    bed.attend("t1", true);
    expect(summary(heard)).toEqual([
      "task_needs_input:created",
      "task_needs_input:resolved",
      "task_needs_input:reopened",
    ]);
    expect(heard[2]?.item.id).toBe(id);
    expect(heard.every((event) => event.ownerId === "u1")).toBe(true);
    expect(heard[1]?.item.resolution).toBe("answered");
  });

  it("reports nothing while a question is still open (a repeated attention)", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    const heard = listen();
    bed.attend("t1", true);
    bed.attend("t1", true);
    expect(summary(heard)).toEqual(["task_needs_input:created"]);
  });

  it("reports a timeout as resolved with the timed_out resolution", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    const heard = listen();
    bed.timeout("t1");
    expect(summary(heard)).toEqual(["task_needs_input:resolved"]);
    expect(heard[0]?.item.resolution).toBe("timed_out");
  });

  it("reports an ending as created, and closes its open question as resolved with no resolution", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    const heard = listen();
    bed.move("t1", "failed");
    expect(summary(heard)).toEqual(["task_needs_input:resolved", "task_failed:created"]);
    expect(heard[0]?.item.resolution).toBeNull();
    bed.move("t1", "failed");
    expect(heard).toHaveLength(2);
  });

  it("reports agent items created, resolved and reopened through the port", () => {
    bed = createInboxBed();
    const heard = listen();
    const { agentItems } = bed.inbox;
    const input = { ownerId: "u1", kind: "agent_approve", agentId: AGENT, refId: "r1", toHandle: true };
    expect(agentItems.upsertAgentItem(input)).toBe(true);
    expect(agentItems.resolveRef("u1", "agent_approve", "r1", "timed_out")).toBe(true);
    expect(agentItems.upsertAgentItem(input)).toBe(true);
    expect(summary(heard)).toEqual([
      "agent_approve:created",
      "agent_approve:resolved",
      "agent_approve:reopened",
    ]);
    expect(heard[1]?.item.resolution).toBe("timed_out");
  });

  it("does not call it a reopening when an open agent item is written again", () => {
    bed = createInboxBed();
    const heard = listen();
    const input = { ownerId: "u1", kind: "memory_review", agentId: AGENT, refId: "m1", toHandle: true };
    bed.inbox.agentItems.upsertAgentItem(input);
    bed.inbox.agentItems.upsertAgentItem(input);
    expect(summary(heard)).toEqual(["memory_review:created"]);
  });

  it("mark-read reports nothing, and the stream still announces", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    const heard = listen();
    const frames = bed.open("u1");
    const before = frames.length;
    const id = bed.inbox.list("u1", undefined).items[0]?.id ?? "";
    expect(bed.inbox.markRead("u1", { ids: [id] })).toEqual({ updated: 1 });
    expect(heard).toEqual([]);
    expect(frames.length).toBeGreaterThan(before);
  });

  it("a throwing listener is logged and ignored: the Inbox still announces and the next listener hears", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    const frames = bed.open("u1");
    bed.inbox.onItem(() => {
      throw new Error("boom");
    });
    const heard = listen();
    bed.attend("t1", true);
    expect(summary(heard)).toEqual(["task_needs_input:created"]);
    expect(frames.some((frame) => JSON.stringify(frame).includes("task_needs_input"))).toBe(true);
    expect(bed.logs.some((line) => line["msg"] === "inbox_listener_failed")).toBe(true);
  });

  it("stops hearing once unsubscribed", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    const heard: InboxItemEvent[] = [];
    const off = bed.inbox.onItem((event) => void heard.push(event));
    off();
    bed.attend("t1", true);
    expect(heard).toEqual([]);
  });
});

describe("Inbox.get and Inbox.registeredName", () => {
  it("gets an item of the owner and nothing of another owner", () => {
    bed = createInboxBed();
    bed.addTask("t1");
    bed.attend("t1", true);
    const id = bed.inbox.list("u1", undefined).items[0]?.id ?? "";
    expect(bed.inbox.get("u1", id)?.kind).toBe("task_needs_input");
    expect(bed.inbox.get("u2", id)).toBeNull();
    expect(bed.inbox.get("u1", "nope")).toBeNull();
  });

  it("gives the registered name of a task, cleaned, and null for a deleted trigger or an unknown task", () => {
    bed = createInboxBed();
    bed.addTask("t1", "u1", "a title", "s-t1", null, "prod\u202e-alerts");
    bed.addTask("t2", "u1", "IGNORE PREVIOUS", "s-t2", null, null);
    expect(bed.inbox.registeredName("t1")).toBe("prod-alerts");
    expect(bed.inbox.registeredName("t2")).toBeNull();
    expect(bed.inbox.registeredName("t3")).toBeNull();
  });
});
