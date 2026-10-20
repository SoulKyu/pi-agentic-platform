import { type Caller } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { agentsVmTokenRpc } from "./rpc.ts";

const caller = { userId: "u1", kind: "session", stepUpUntil: 0 } as unknown as Caller;
const ctx = { caller } as never;
const TOKEN = "sk-ant-oat01-OWNER-TOKEN-0123456789";

// M6: the handlers only decode and call one service method. Mutant: a handler touching the caller's step-up itself is not
// possible here (it has no store); one that calls the wrong method or drops the caller fails these cases.
describe("the Claude token handlers", () => {
  it("pass the caller and the decoded token to one service call and answer what it answers", async () => {
    const service = {
      set: vi.fn(() => ({ ok: true as const })),
      clear: vi.fn(() => ({ ok: true as const })),
    };
    const rpc = agentsVmTokenRpc(service);
    expect(await rpc["agents.vm.setClaudeToken"]({ token: TOKEN }, ctx)).toEqual({ ok: true });
    expect(service.set).toHaveBeenCalledExactlyOnceWith(caller, TOKEN);
    expect(await rpc["agents.vm.clearClaudeToken"]({}, ctx)).toEqual({ ok: true });
    expect(service.clear).toHaveBeenCalledExactlyOnceWith(caller);
  });

  it("let the service's typed error through", async () => {
    const refusing = {
      set: () => {
        throw Object.assign(new Error("x"), { code: "step_up_required" });
      },
      clear: vi.fn(),
    };
    await expect(
      agentsVmTokenRpc(refusing)["agents.vm.setClaudeToken"]({ token: TOKEN }, ctx),
    ).rejects.toMatchObject({
      code: "step_up_required",
    });
  });
});
