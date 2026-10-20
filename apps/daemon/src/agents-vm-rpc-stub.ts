import type { HandlerTable } from "@pap/contracts";

type VmHandlers = Pick<HandlerTable, "agents.vmStatus">;

/**
 * T1's placeholder for the one VM method still without a module: `agents.vmStatus` (T18 replaces it and deletes this file). The
 * Claude-token methods are real (`modules/agent-vm/rpc.ts`, J1) and `agents.purgeTrash` is the agents module's (T15).
 */
export const agentsVmRpcStub: VmHandlers = {
  "agents.vmStatus": async () => ({
    runtime: "host",
    usable: false,
    reason: "not_configured",
    vmdVersion: null,
    claudeToken: "missing",
    agents: [],
  }),
};
