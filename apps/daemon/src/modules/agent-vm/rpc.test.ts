import { type Caller, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { agentsVmTokenRpc } from "./rpc.ts";

/*
 * Mutants (RT-43), each run for real: the step-up guard dropped from a handler -> "asks for the step-up first" fails for that
 * method; the guard called after the store -> the same case (the store was already written).
 */
const caller = { userId: "u1", kind: "session", stepUpUntil: 0 } as unknown as Caller;
const ctx = { caller } as never;
const TOKEN = "sk-ant-oat01-OWNER-TOKEN-0123456789";
const allowed = () => {};
const noAudit = { append: vi.fn() };
const refused = () => {
  throw new PapError("step_up_required");
};

describe("the Claude token handlers", () => {
  it("decode, call the store once and answer ok without the value", async () => {
    const store = { set: vi.fn(), clear: vi.fn() };
    const rpc = agentsVmTokenRpc(store, allowed, noAudit);
    const answer = await rpc["agents.vm.setClaudeToken"]({ token: TOKEN }, ctx);
    expect(answer).toEqual({ ok: true });
    expect(store.set).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(await rpc["agents.vm.clearClaudeToken"]({}, ctx)).toEqual({ ok: true });
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it("audits a set and a clear, never the value (M-audit)", async () => {
    const audit = { append: vi.fn() };
    const rpc = agentsVmTokenRpc({ set: vi.fn(), clear: vi.fn() }, allowed, audit);
    await rpc["agents.vm.setClaudeToken"]({ token: TOKEN }, ctx);
    await rpc["agents.vm.clearClaudeToken"]({}, ctx);
    expect(audit.append.mock.calls.map(([line]) => line)).toEqual([
      { ownerId: "u1", actor: "user", kind: "auth", reason: "claude_token_set" },
      { ownerId: "u1", actor: "user", kind: "auth", reason: "claude_token_cleared" },
    ]);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(TOKEN);
  });

  it("writes no row when the step-up refuses", async () => {
    const audit = { append: vi.fn() };
    await expect(
      agentsVmTokenRpc({ set: vi.fn(), clear: vi.fn() }, refused, audit)["agents.vm.setClaudeToken"](
        { token: TOKEN },
        ctx,
      ),
    ).rejects.toThrow();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("asks for the step-up first: a refused guard leaves the store untouched", async () => {
    const store = { set: vi.fn(), clear: vi.fn() };
    const rpc = agentsVmTokenRpc(store, refused, noAudit);
    await expect(rpc["agents.vm.setClaudeToken"]({ token: TOKEN }, ctx)).rejects.toMatchObject({
      code: "step_up_required",
    });
    await expect(rpc["agents.vm.clearClaudeToken"]({}, ctx)).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect(store.set).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("gives the guard the caller of the call", async () => {
    const guard = vi.fn();
    await agentsVmTokenRpc({ set: vi.fn(), clear: vi.fn() }, guard, noAudit)["agents.vm.clearClaudeToken"](
      {},
      ctx,
    );
    expect(guard).toHaveBeenCalledExactlyOnceWith(caller);
  });

  it("lets the store's typed error through", async () => {
    const store = {
      set: vi.fn(() => {
        throw new PapError("internal");
      }),
      clear: vi.fn(),
    };
    await expect(
      agentsVmTokenRpc(store, allowed, noAudit)["agents.vm.setClaudeToken"]({ token: TOKEN }, ctx),
    ).rejects.toThrow(PapError);
  });
});
