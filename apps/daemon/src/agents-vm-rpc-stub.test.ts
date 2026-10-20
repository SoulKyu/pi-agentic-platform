import { describe, expect, it } from "vitest";
import { agentsVmRpcStub } from "./agents-vm-rpc-stub.ts";
import type { HandlerContext } from "@pap/contracts";

const ctx = {} as HandlerContext;

describe("agentsVmRpcStub", () => {
  it("answers the host runtime until T18 replaces it", async () => {
    await expect(agentsVmRpcStub["agents.vmStatus"]({}, ctx)).resolves.toMatchObject({
      runtime: "host",
      usable: false,
    });
  });

  it("holds neither the Claude token methods (J1) nor the purge (T15)", () => {
    expect(Object.keys(agentsVmRpcStub)).toEqual(["agents.vmStatus"]);
  });
});
