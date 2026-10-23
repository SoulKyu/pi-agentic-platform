import { INBOX_KINDS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { itemOf, NOW } from "./inbox-bed.tsx";
import { FILTERS, isAgentItem, visible } from "./inbox.vm.ts";

const agent = (kind: string, id: string, patch: Partial<ReturnType<typeof itemOf>> = {}) =>
  itemOf({
    id,
    kind,
    agentId: "atlas-1a2b",
    refId: `ref-${id}`,
    taskId: null,
    sessionId: null,
    toHandle: (INBOX_KINDS.toHandle as readonly string[]).includes(kind),
    createdAt: NOW - 1000,
    ...patch,
  });

describe("the M11 filters", () => {
  it("offers All, To handle, Replies and Tasks, in that order", () => {
    expect(FILTERS).toEqual(["all", "handle", "replies", "tasks"]);
  });

  it("keeps the reply kinds of INBOX_KINDS for Replies, and nothing else", () => {
    const items = [
      ...INBOX_KINDS.replies.map((kind, n) => agent(kind, `r${n}`)),
      agent("agent_notify", "n1"),
      agent("agent_approve", "a1"),
      itemOf({ id: "t1", kind: "task_done", toHandle: false }),
    ];
    expect(
      visible(items, "replies")
        .map((item) => item.id)
        .sort(),
    ).toEqual(["r0", "r1"]);
  });

  it("keeps the to-handle agent kinds for To handle, unresolved only", () => {
    const items = [
      agent("agent_approve", "a1"),
      agent("secret_request", "s1"),
      agent("secret_request", "s2", { resolvedAt: NOW, resolution: "answered" }),
      agent("agent_reply", "r1"),
    ];
    expect(
      visible(items, "handle")
        .map((item) => item.id)
        .sort(),
    ).toEqual(["a1", "s1"]);
  });

  it("keeps the task kinds for Tasks and no agent kind", () => {
    const items = [
      itemOf({ id: "t1", kind: "task_done", toHandle: false }),
      itemOf({ id: "t2", kind: "task_limited", toHandle: false }),
      agent("agent_reply", "r1"),
      agent("agent_approve", "a1"),
    ];
    expect(
      visible(items, "tasks")
        .map((item) => item.id)
        .sort(),
    ).toEqual(["t1", "t2"]);
  });

  it("puts the to-handle items first in All, then newest first", () => {
    const items = [
      agent("agent_reply", "r1", { createdAt: NOW - 10 }),
      agent("agent_notify", "n1", { createdAt: NOW - 20 }),
      agent("secret_request", "s1", { createdAt: NOW - 5000 }),
    ];
    expect(visible(items, "all").map((item) => item.id)).toEqual(["s1", "r1", "n1"]);
  });

  it("shows a kind this build does not know in All, and in no other filter", () => {
    const unknown = agent("future_kind", "u1");
    expect(visible([unknown], "all")).toHaveLength(1);
    for (const filter of ["handle", "replies", "tasks"] as const)
      expect(visible([unknown], filter)).toEqual([]);
  });
});

describe("isAgentItem", () => {
  it("is true for an item that names an agent, whatever its kind", () => {
    expect(isAgentItem(agent("future_kind", "u1"))).toBe(true);
    expect(isAgentItem(itemOf({ kind: "task_done" }))).toBe(false);
  });
});
