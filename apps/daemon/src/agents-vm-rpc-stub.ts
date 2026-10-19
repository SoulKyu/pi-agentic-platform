import { PapError, type HandlerTable } from "@pap/contracts";

type VmHandlers = Pick<
  HandlerTable,
  "agents.vm.setClaudeToken" | "agents.vm.clearClaudeToken" | "agents.vmStatus" | "agents.purgeTrash"
>;

const refused = async (): Promise<never> => {
  throw new PapError("sandbox_unavailable");
};

/**
 * T1's placeholder for the four VM methods of `agents-vm-methods.ts`: every method of the catalogue needs a handler
 * (`HandlerTable`). The VM runtime tasks replace it with the real module; until then the runtime is the host and the
 * writes answer `sandbox_unavailable`.
 */
export const agentsVmRpcStub: VmHandlers = {
  "agents.vm.setClaudeToken": refused,
  "agents.vm.clearClaudeToken": refused,
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
