import { type Caller, type HandlerContext, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { policyRpc } from "./rpc.ts";
import type { PolicyService } from "./service.ts";
import { testCaller } from "../../testing/caller.ts";

const caller: Caller = testCaller();
const ctx: HandlerContext = {
  caller,
  connectionId: "c1",
  openSubscription: vi.fn(() => "s1"),
  closeSubscription: vi.fn(),
};

function setup(overrides: Partial<PolicyService> = {}) {
  const service = {
    listPage: vi.fn(() => ({ rules: [], truncated: false })),
    revoke: vi.fn(),
    ...overrides,
  } as unknown as PolicyService;
  return { rpc: policyRpc(service), service };
}

describe("policy rpc", () => {
  it("lists the caller's rules, whatever the params say about owners", async () => {
    const { rpc, service } = setup();
    expect(await rpc["policy.listRules"]({}, ctx)).toEqual({ rules: [], truncated: false });
    expect(service.listPage).toHaveBeenCalledWith("u1", undefined);
    await rpc["policy.listRules"]({ cwd: "/w" }, ctx);
    expect(service.listPage).toHaveBeenLastCalledWith("u1", "/w");
  });

  it("revokes for the caller and lets not_found through", async () => {
    const { rpc, service } = setup();
    expect(await rpc["policy.revokeRule"]({ ruleId: "r1" }, ctx)).toEqual({ ok: true });
    expect(service.revoke).toHaveBeenCalledWith(caller, "r1");
    const failing = setup({
      revoke: vi.fn(() => {
        throw new PapError("not_found");
      }),
    });
    await expect(failing.rpc["policy.revokeRule"]({ ruleId: "r2" }, ctx)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
