import type { HandlerTable, HealthEvent } from "@pap/contracts";

export type HealthRpc = Pick<HandlerTable, "ops.events.list" | "subscribe.ops">;

/** The owner is the caller the transport stamped, never a param; each handler is one service call. */
export function healthRpc(service: {
  page(
    ownerId: string,
    params: { before?: number; limit?: number },
  ): { events: HealthEvent[]; hasMore: boolean };
}): HealthRpc {
  return {
    "ops.events.list": async (params, ctx) => service.page(ctx.caller.userId, params),
    "subscribe.ops": async (params, ctx) => ({
      sub: ctx.openSubscription("ops", ctx.caller.userId, params.after),
    }),
  };
}
