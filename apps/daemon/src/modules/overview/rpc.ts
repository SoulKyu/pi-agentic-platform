import type { HandlerTable, OverviewSnapshot } from "@pap/contracts";
import type { OverviewScope } from "./snapshot.ts";

export type OverviewRpc = Pick<HandlerTable, "overview.get" | "subscribe.overview">;

/**
 * The viewer is the caller the transport stamped, never a param: both methods read their own id, so a caller cannot ask for
 * another person's Overview (M14). Each handler is one service call.
 */
export function overviewRpc(service: {
  get(viewerId: string, scope: OverviewScope): Promise<OverviewSnapshot>;
  /** Registers the viewer for ticks, then opens the stream on the key `open` is given. */
  subscribe(viewerId: string, open: (key: string) => string): string;
}): OverviewRpc {
  return {
    "overview.get": async (_params, ctx) =>
      service.get(ctx.caller.userId, {
        members: ctx.caller.permissions.has("users:read"),
        failures: ctx.caller.permissions.has("pi:admin"),
      }),
    "subscribe.overview": async (params, ctx) => ({
      sub: service.subscribe(ctx.caller.userId, (key) => ctx.openSubscription("overview", key, params.after)),
    }),
  };
}
