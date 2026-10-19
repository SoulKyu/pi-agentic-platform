import type { Caller, HandlerTable } from "@pap/contracts";
import type { ClaudeTokenStore } from "./claude-token.ts";

export type AgentsVmTokenRpc = Pick<HandlerTable, "agents.vm.setClaudeToken" | "agents.vm.clearClaudeToken">;

/**
 * The two Claude-token methods of `agents-vm-methods.ts` (RT-46): decode (the contract trims and bounds the token), the
 * step-up the contract promises, one call on the store, nothing else. Registered in host and vm modes alike: the token is kept whatever runtime is on, and the
 * relay link (vm mode) hears of it through the store's listener. The result never carries the value.
 */
export function agentsVmTokenRpc(
  store: Pick<ClaudeTokenStore, "set" | "clear">,
  /** The owner's password was confirmed lately (`step_up_required` otherwise): like `models.setApiKey`, the browser only. */
  requireStepUp: (caller: Caller) => void,
): AgentsVmTokenRpc {
  return {
    "agents.vm.setClaudeToken": async ({ token }, ctx) => {
      requireStepUp(ctx.caller);
      store.set(token);
      return { ok: true };
    },
    "agents.vm.clearClaudeToken": async (_params, ctx) => {
      requireStepUp(ctx.caller);
      store.clear();
      return { ok: true };
    },
  };
}
