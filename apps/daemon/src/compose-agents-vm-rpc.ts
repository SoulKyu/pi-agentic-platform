import type { HandlerTable, VmStatusView } from "@pap/contracts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import {
  agentsVmTokenRpc,
  type ClaudeTokenStore,
  createClaudeTokenService,
  createClaudeTokenStore,
  createHostStatus,
  secretsDirOf,
} from "./modules/agent-vm/index.ts";

export type AgentsVmRpc = Pick<
  HandlerTable,
  "agents.vm.setClaudeToken" | "agents.vm.clearClaudeToken" | "agents.vmStatus"
>;

/**
 * The `agents.vm.*` / `agents.vmStatus` handlers, in host and vm modes alike (AVM-P17, no `unknown_method` in host mode), and
 * the Claude token store behind the first two (`$PAP_HOME/secrets/claude-token`). `agents.purgeTrash` is the agents module's.
 * `agents.vmStatus` answers the host-mode view until `bindStatus` is given the VM composition's (`vm` mode, T18).
 */
export function composeAgentsVmRpc(
  config: Pick<Config, "home">,
  logger: Logger,
  clock: Pick<Clock, "now">,
  audit: Pick<AuditPort, "append">,
): {
  readonly claudeToken: ClaudeTokenStore;
  readonly rpc: AgentsVmRpc;
  bindStatus(view: ((ownerId: string) => Promise<VmStatusView>) | undefined): void;
} {
  const claudeToken = createClaudeTokenStore({
    secretsDir: secretsDirOf(config.home),
    logger: logger.child({ module: "agent-vm" }),
  });
  const hostView = createHostStatus(claudeToken);
  let vmView: ((ownerId: string) => Promise<VmStatusView>) | undefined;
  return {
    claudeToken,
    bindStatus: (view) => void (vmView = view),
    rpc: {
      "agents.vmStatus": async (_params, ctx) => (vmView ? vmView(ctx.caller.userId) : hostView()),
      ...agentsVmTokenRpc(
        createClaudeTokenService(claudeToken, (caller) => requireStepUp(caller, clock.now()), audit),
      ),
    },
  };
}
