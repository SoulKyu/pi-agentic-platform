import type { HandlerTable } from "@pap/contracts";
import type { TransportService } from "./service.ts";

export type TransportRpc = Pick<HandlerTable, "push.config" | "push.subscribe" | "push.list" | "push.revoke">;

/** Each handler decodes (the dispatcher did), makes one service call and lets typed errors through; the browser-only check is the service's (M12R10). */
export function transportRpc(service: TransportService): TransportRpc {
  return {
    "push.config": async (_params, ctx) => service.config(ctx.caller),
    "push.subscribe": async ({ subscription }, ctx) => service.subscribe(ctx.caller, subscription),
    "push.list": async (_params, ctx) => service.list(ctx.caller),
    "push.revoke": async ({ id }, ctx) => service.revoke(ctx.caller, id),
  };
}
