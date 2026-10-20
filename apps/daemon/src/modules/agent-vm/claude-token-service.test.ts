import { type Caller, PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createClaudeTokenService } from "./claude-token-service.ts";

/*
 * Mutants (RT-43), each run for real: the step-up guard dropped from a handler -> "asks for the step-up first" fails for that
 * method; the guard called after the store -> the same case (the store was already written).
 */
const caller = { userId: "u1", kind: "session", stepUpUntil: 0 } as unknown as Caller;
const TOKEN = "sk-ant-oat01-OWNER-TOKEN-0123456789";
const allowed = () => {};
const noAudit = { append: vi.fn() };
const refused = () => {
  throw new PapError("step_up_required");
};

describe("the Claude token service (M6: step-up, store, audit)", () => {
  it("calls the store once and answers ok without the value", () => {
    const store = { set: vi.fn(), clear: vi.fn() };
    const rpc = createClaudeTokenService(store, allowed, noAudit);
    const answer = rpc.set(caller, TOKEN);
    expect(answer).toEqual({ ok: true });
    expect(store.set).toHaveBeenCalledExactlyOnceWith(TOKEN);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(rpc.clear(caller)).toEqual({ ok: true });
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it("audits a set and a clear, never the value (M-audit)", () => {
    const audit = { append: vi.fn() };
    const rpc = createClaudeTokenService({ set: vi.fn(), clear: vi.fn() }, allowed, audit);
    rpc.set(caller, TOKEN);
    rpc.clear(caller);
    expect(audit.append.mock.calls.map(([line]) => line)).toEqual([
      { ownerId: "u1", actor: "user", kind: "auth", reason: "claude_token_set" },
      { ownerId: "u1", actor: "user", kind: "auth", reason: "claude_token_cleared" },
    ]);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(TOKEN);
  });

  it("writes no row when the step-up refuses", () => {
    const audit = { append: vi.fn() };
    expect(() =>
      createClaudeTokenService({ set: vi.fn(), clear: vi.fn() }, refused, audit).set(caller, TOKEN),
    ).toThrow();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("asks for the step-up first: a refused guard leaves the store untouched", () => {
    const store = { set: vi.fn(), clear: vi.fn() };
    const rpc = createClaudeTokenService(store, refused, noAudit);
    expect(() => rpc.set(caller, TOKEN)).toThrow(expect.objectContaining({ code: "step_up_required" }));
    expect(() => rpc.clear(caller)).toThrow(expect.objectContaining({ code: "step_up_required" }));
    expect(store.set).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("gives the guard the caller of the call", () => {
    const guard = vi.fn();
    createClaudeTokenService({ set: vi.fn(), clear: vi.fn() }, guard, noAudit).clear(caller);
    expect(guard).toHaveBeenCalledExactlyOnceWith(caller);
  });

  it("lets the store's typed error through", () => {
    const store = {
      set: vi.fn(() => {
        throw new PapError("internal");
      }),
      clear: vi.fn(),
    };
    expect(() => createClaudeTokenService(store, allowed, noAudit).set(caller, TOKEN)).toThrow(PapError);
  });
});
