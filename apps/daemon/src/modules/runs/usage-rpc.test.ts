import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { usageRpc } from "./rpc.ts";

function setup() {
  const calls: unknown[][] = [];
  const opened: unknown[][] = [];
  const rpc = usageRpc({
    resumeNow: async (caller, sessionId) =>
      void calls.push(["resumeNow", caller.userId, caller.kind, sessionId]),
    cancelResume: async (ownerId, sessionId) => void calls.push(["cancelResume", ownerId, sessionId]),
  });
  const context = (caller = testCaller({ userId: "u1" })) => ({
    caller,
    connectionId: "c",
    openSubscription: (...args: unknown[]) => {
      opened.push(args);
      return "sub-1";
    },
    closeSubscription: () => {},
  });
  return { rpc, calls, opened, context };
}

describe("the usage handlers", () => {
  it("opens the usage stream keyed by the caller, never by params", async () => {
    const { rpc, opened, context } = setup();
    expect(await rpc["subscribe.usage"]({}, context())).toEqual({ sub: "sub-1" });
    expect(opened).toEqual([["usage", "u1", undefined]]);
  });

  it("hands the caller (kind included, for the token budget) and the session to the service", async () => {
    const { rpc, calls, context } = setup();
    const token = testCaller({ userId: "u1", kind: "token" });
    expect(await rpc["usage.resumeNow"]({ sessionId: "s1" }, context(token))).toEqual({ ok: true });
    expect(await rpc["usage.cancelResume"]({ sessionId: "s1" }, context())).toEqual({ ok: true });
    expect(calls).toEqual([
      ["resumeNow", "u1", "token", "s1"],
      ["cancelResume", "u1", "s1"],
    ]);
  });
});
