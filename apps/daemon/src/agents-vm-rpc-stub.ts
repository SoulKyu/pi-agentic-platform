import { PapError, type HandlerTable } from "@pap/contracts";

type VmHandlers = Pick<HandlerTable, "agents.vmStatus" | "agents.purgeTrash">;

const refused = async (): Promise<never> => {
  throw new PapError("sandbox_unavailable");
};

/**
 * T1's placeholder for the two VM methods still without a module: `agents.purgeTrash` (T15) and `agents.vmStatus` (T18). The
 * Claude-token methods are real (`modules/agent-vm/rpc.ts`, J1). The task that replaces the last of these deletes this file.
 */
export const agentsVmRpcStub: VmHandlers = {
  "agents.purgeTrash": refused,
  "agents.vmStatus": async () => ({
    runtime: "host",
    usable: false,
    reason: "not_configured",
    vmdVersion: null,
    claudeToken: "missing",
    agents: [],
  }),
};
