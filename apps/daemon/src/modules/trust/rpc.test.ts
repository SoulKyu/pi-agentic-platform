import { describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { trustRpc } from "./rpc.ts";
import type { TrustService } from "./service.ts";

const ctx = {
  caller: testCaller(),
  connectionId: "c1",
  openSubscription: () => "s",
  closeSubscription: () => {},
};

describe("trustRpc", () => {
  it("hands each method to one service call with the caller and the decoded params", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const service = {
      status: async (...args: unknown[]) => (calls.push(["status", args]), {}),
      set: async (...args: unknown[]) => (calls.push(["set", args]), { ok: true }),
    } as unknown as TrustService;
    const rpc = trustRpc(service);
    await rpc["trust.status"]({ cwd: "/w" }, ctx);
    await rpc["trust.set"]({ cwd: "/w", decision: null }, ctx);
    expect(calls).toEqual([
      ["status", [ctx.caller, "/w"]],
      ["set", [ctx.caller, { cwd: "/w", decision: null }]],
    ]);
    expect(Object.keys(rpc).sort()).toEqual(["trust.set", "trust.status"]);
  });
});
