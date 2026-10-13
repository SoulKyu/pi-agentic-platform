import type { HandlerTable } from "@pap/contracts";
import type { PolicyService } from "./service.ts";
import type { SessionPolicyService } from "./session-service.ts";

export type PolicyRpc = Pick<HandlerTable, "policy.listRules" | "policy.revokeRule">;

export function policyRpc(service: PolicyService): PolicyRpc {
  return {
    "policy.listRules": async ({ cwd }, ctx) => service.listPage(ctx.caller.userId, cwd),
    "policy.revokeRule": async ({ ruleId }, ctx) => {
      service.revoke(ctx.caller, ruleId);
      return { ok: true as const };
    },
  };
}

export type PolicyV2Rpc = Pick<
  HandlerTable,
  "policy.getSettings" | "policy.setSettings" | "policy.setSessionMode" | "policy.clearTaint"
>;

export function policyV2Rpc(service: SessionPolicyService): PolicyV2Rpc {
  return {
    "policy.getSettings": async (_params, ctx) => service.getSettings(ctx.caller),
    "policy.setSettings": async ({ value, baseRevision }, ctx) =>
      service.setSettings(ctx.caller, value, baseRevision),
    "policy.setSessionMode": async ({ sessionId, mode }, ctx) => {
      service.setSessionMode(ctx.caller, sessionId, mode);
      return { ok: true as const };
    },
    "policy.clearTaint": async ({ sessionId }, ctx) => {
      service.clearTaint(ctx.caller, sessionId);
      return { ok: true as const };
    },
  };
}
