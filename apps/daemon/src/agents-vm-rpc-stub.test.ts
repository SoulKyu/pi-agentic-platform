import { describe, expect, it } from "vitest";
import { agentsVmRpcStub } from "./agents-vm-rpc-stub.ts";
import type { HandlerContext } from "@pap/contracts";

const ctx = {} as HandlerContext;

describe("agentsVmRpcStub", () => {
  it("answers the host runtime and refuses the writes while no VM runtime exists", async () => {
    await expect(agentsVmRpcStub["agents.vmStatus"]({}, ctx)).resolves.toMatchObject({
      runtime: "host",
      usable: false,
    });
    await expect(agentsVmRpcStub["agents.vm.setClaudeToken"]({ token: "t" }, ctx)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });
});
