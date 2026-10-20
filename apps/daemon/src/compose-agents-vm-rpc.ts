import { join } from "node:path";
import type { HandlerTable } from "@pap/contracts";
import { agentsVmRpcStub } from "./agents-vm-rpc-stub.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import { agentsVmTokenRpc, type ClaudeTokenStore, createClaudeTokenStore } from "./modules/agent-vm/index.ts";

export type AgentsVmRpc = Pick<
  HandlerTable,
  "agents.vm.setClaudeToken" | "agents.vm.clearClaudeToken" | "agents.vmStatus" | "agents.purgeTrash"
>;

/**
 * The four `agents.vm.*` / `agents.vmStatus` / `agents.purgeTrash` handlers, in host and vm modes alike (AVM-P17, no
 * `unknown_method` in host mode), and the Claude token store behind the first two (`$PAP_HOME/secrets/claude-token`).
 */
export function composeAgentsVmRpc(
  config: Pick<Config, "home">,
  logger: Logger,
  clock: Pick<Clock, "now">,
  audit: Pick<AuditPort, "append">,
): { readonly claudeToken: ClaudeTokenStore; readonly rpc: AgentsVmRpc } {
  const claudeToken = createClaudeTokenStore({
    secretsDir: join(config.home, "secrets"),
    logger: logger.child({ module: "agent-vm" }),
  });
  return {
    claudeToken,
    rpc: {
      ...agentsVmRpcStub,
      ...agentsVmTokenRpc(claudeToken, (caller) => requireStepUp(caller, clock.now()), audit),
    },
  };
}
