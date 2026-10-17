import { PapError, type HandlerTable } from "@pap/contracts";
import { requireBrowser, type PushPresence } from "../service.ts";
import type { OpenPush } from "./open.ts";
import type { TestPush } from "./test-push.ts";

export type DeliveryRpc = Pick<HandlerTable, "push.test" | "push.presence" | "push.open">;

/**
 * Each handler decodes and calls one service (the service checks the caller too). A service that is not given answers
 * push_unavailable after the caller check, so a token learns nothing either way. `push.presence` takes the connection id
 * from the authenticated context, never from the params (task 8 carry).
 */
export function deliveryRpc(
  services: { readonly test?: TestPush; readonly presence?: PushPresence; readonly open?: OpenPush } = {},
): DeliveryRpc {
  return {
    "push.test": async (_params, ctx) => {
      requireBrowser(ctx.caller);
      if (!services.test) throw new PapError("push_unavailable");
      return services.test(ctx.caller);
    },
    "push.presence": async (params, ctx) => {
      requireBrowser(ctx.caller);
      if (!services.presence) throw new PapError("push_unavailable");
      services.presence.report(ctx.caller.userId, ctx.connectionId, params.focused);
      return { ok: true as const };
    },
    "push.open": async (params, ctx) => {
      requireBrowser(ctx.caller);
      if (!services.open) throw new PapError("push_unavailable");
      return services.open(ctx.caller, params.id);
    },
  };
}
