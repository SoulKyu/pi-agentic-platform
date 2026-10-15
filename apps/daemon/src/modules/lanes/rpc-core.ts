import type { HandlerTable } from "@pap/contracts";
import type { LanesService } from "./service.ts";

export type LanesCoreRpc = Pick<
  HandlerTable,
  "subscribe.lane" | "lanes.listArchived" | "lanes.create" | "lanes.newSession"
>;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = [
  "subscribe.lane",
  "lanes.listArchived",
  "lanes.create",
  "lanes.newSession",
] as const satisfies readonly (keyof LanesCoreRpc)[];

export function lanesCoreRpc(
  service: Pick<LanesService, "create" | "newSession" | "listArchived">,
): LanesCoreRpc {
  return {
    // The key is the caller, never a param: the stream is the caller's own lanes (like `shell`).
    "subscribe.lane": async ({ after }, ctx) => ({
      sub: ctx.openSubscription("lane", ctx.caller.userId, after),
    }),
    "lanes.listArchived": async (params, ctx) => service.listArchived(ctx.caller, params),
    "lanes.create": async (params, ctx) => service.create(ctx.caller, params),
    "lanes.newSession": async ({ laneId }, ctx) => service.newSession(ctx.caller, laneId),
  };
}
