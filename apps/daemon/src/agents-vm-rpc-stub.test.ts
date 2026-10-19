import { describe, expect, it } from "vitest";
import { agentsVmRpcStub } from "./agents-vm-rpc-stub.ts";
import type { HandlerContext } from "@pap/contracts";

const ctx = {} as HandlerContext;
const AGENT = "scout-0001";

describe("agentsVmRpcStub", () => {
  it("answers the host runtime and refuses the purge while no VM runtime exists (T15 and T18 replace them)", async () => {
    await expect(agentsVmRpcStub["agents.vmStatus"]({}, ctx)).resolves.toMatchObject({
      runtime: "host",
      usable: false,
    });
    await expect(agentsVmRpcStub["agents.purgeTrash"]({ agentId: AGENT }, ctx)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("no longer holds the Claude token methods (J1 implements them)", () => {
    expect(Object.keys(agentsVmRpcStub).sort()).toEqual(["agents.purgeTrash", "agents.vmStatus"]);
  });
});
