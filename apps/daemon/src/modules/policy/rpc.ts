import type { HandlerTable } from "@pap/contracts";
import type { PolicyService } from "./service.ts";

export type PolicyRpc = Pick<HandlerTable, "policy.listRules" | "policy.revokeRule">;

export function policyRpc(service: PolicyService): PolicyRpc {
  return {
    "policy.listRules": async ({ cwd }, ctx) => service.listPage(ctx.caller.userId, cwd),
    "policy.revokeRule": async ({ ruleId }, ctx) => {
      service.revoke(ctx.caller.userId, ruleId);
      return { ok: true as const };
    },
  };
}
