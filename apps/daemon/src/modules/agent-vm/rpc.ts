import type { HandlerTable } from "@pap/contracts";
import type { ClaudeTokenService } from "./claude-token-service.ts";

export type AgentsVmTokenRpc = Pick<HandlerTable, "agents.vm.setClaudeToken" | "agents.vm.clearClaudeToken">;

/** The two Claude-token methods of `agents-vm-methods.ts`: decode (the contract trims and bounds the token), one service call. */
export function agentsVmTokenRpc(service: ClaudeTokenService): AgentsVmTokenRpc {
  return {
    "agents.vm.setClaudeToken": async ({ token }, ctx) => service.set(ctx.caller, token),
    "agents.vm.clearClaudeToken": async (_params, ctx) => service.clear(ctx.caller),
  };
}
