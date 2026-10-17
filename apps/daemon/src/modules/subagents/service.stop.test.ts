import { describe, expect, it } from "vitest";
import { createSubagentService } from "./service.ts";
import { createSubagentStop } from "./stop.ts";
import { createSubagentStore } from "./store.ts";
import { bed as makeBed, type Options, settle } from "./testing/service-bed.ts";

const bed = (options?: Options) =>
  makeBed({ createSubagentService, createSubagentStop, createSubagentStore }, options);

/** The parent's tool call is held for the child; each cause below ends it as `cancelled` and the row with the cause. */
describe("every cause of a stop ends the held call cancelled (M11R139)", () => {
  it("(b) the parent's run ends while the child runs", async () => {
    const b = bed();
    b.stop.watch(b.runs.onRunEnd);
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("parent");
    expect(await b.codeOf(call)).toBe("cancelled");
    expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason: "parent_run_ended" });
    expect(b.calls).toContainEqual(["abort", "child-1"]);
    expect(b.listeners.size).toBe(1);
  });

  it.each(["parent_archived", "parent_deleted"] as const)("(c) %s", async (reason) => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    expect(b.stop.cancelParent("parent", reason)).toBe(1);
    expect(await b.codeOf(call)).toBe("cancelled");
    expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason });
  });

  it("(d) the agent is quarantined", async () => {
    const b = bed({ agentOfParent: "atlas-1a2b" });
    const call = b.service.run({ task: "t" }, b.ctx({ type: "agent-thread", agentId: "atlas-1a2b" }));
    await settle();
    expect(b.stop.cancelAgent("u1", "atlas-1a2b")).toBe(1);
    expect(await b.codeOf(call)).toBe("cancelled");
    expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason: "quarantined" });
  });

  it("releases the stopped child's worker like any ending, and frees the slot", async () => {
    const b = bed({ maxConcurrent: 1 });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.stop.cancelParent("parent", "parent_archived");
    await b.codeOf(call);
    expect(b.sessions.releaseIdle).toHaveBeenCalledWith("u1", "child-1");
    expect(b.store.liveOf("parent")).toBe(0);
  });

  it("a child that finished first is not stopped by a later cause", async () => {
    const b = bed();
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    await call;
    expect(b.stop.cancelParent("parent", "parent_archived")).toBe(0);
    expect(b.store.get("id-1")?.state).toBe("done");
  });

  it("tells the parent's screen when the child exists and again when its call ends, however it ended", async () => {
    for (const how of ["done", "stopped"] as const) {
      const b = bed();
      const call = b.service.run({ task: "t" }, b.ctx());
      await settle();
      expect(b.sessions.changed).toHaveBeenCalledWith("parent");
      const before = b.sessions.changed.mock.calls.length;
      if (how === "done") b.finish("child-1");
      else b.stop.cancelParent("parent", "parent_archived");
      await b.codeOf(call);
      expect(b.sessions.changed.mock.calls.length).toBe(before + 1);
    }
  });
});

describe("a stop during the prompt's hand-off (review I2)", () => {
  it("sends no prompt: the held prompt is dropped as handled, the call is cancelled and the row says why", async () => {
    const b = bed({ holdPrompt: true });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    expect(b.sessions.prompt).toHaveBeenCalledTimes(1);
    b.stop.cancelParent("parent", "parent_archived");
    b.releasePrompt();
    expect(await b.codeOf(call)).toBe("cancelled");
    expect(b.sent).toEqual([]);
    expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason: "parent_archived" });
  });

  it("sends the prompt when nothing stopped the call", async () => {
    const b = bed({ holdPrompt: true });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.releasePrompt();
    await settle();
    b.finish("child-1");
    await call;
    expect(b.sent).toEqual(["child-1"]);
  });
});

describe("the parent may be archived or gone (review M1)", () => {
  it("refuses a call from a parent that is not open, making no child and no row", async () => {
    const b = bed({ parentOpen: [false] });
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx()))).toBe("not_found");
    expect(b.sessions.createChild).not.toHaveBeenCalled();
    expect(b.store.startedSince("u1", 0)).toBe(0);
  });

  it("stops the child at once when the parent was archived while it was made", async () => {
    const b = bed({ parentOpen: [true, false] });
    expect(await b.codeOf(b.service.run({ task: "t" }, b.ctx()))).toBe("cancelled");
    expect(b.sent).toEqual([]);
    expect(b.calls).toContainEqual(["abort", "child-1"]);
    expect(b.store.get("id-1")).toMatchObject({ state: "cancelled", reason: "parent_archived" });
  });
});

describe("an answer that was delivered is not cancelled (review M3)", () => {
  it("keeps the row done when a stop comes while the answer is read", async () => {
    const b = bed();
    b.sessions.lastText.mockImplementationOnce(async () => {
      b.stop.cancelParent("parent", "parent_archived");
      return "the answer";
    });
    const call = b.service.run({ task: "t" }, b.ctx());
    await settle();
    b.finish("child-1");
    expect(await call).toMatchObject({ answer: "the answer" });
    expect(b.store.get("id-1")).toMatchObject({ state: "done", reason: null });
    expect(b.calls).not.toContainEqual(["abort", "child-1"]);
  });
});
