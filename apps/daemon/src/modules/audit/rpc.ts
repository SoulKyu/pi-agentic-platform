import type { HandlerTable } from "@pap/contracts";
import type { AuditService } from "./service.ts";

export type AuditRpc = Pick<HandlerTable, "audit.list">;

export function auditRpc(service: AuditService): AuditRpc {
  return { "audit.list": async (params, ctx) => service.list(ctx.caller, params) };
}
