import type { HandlerTable } from "@pap/contracts";
import type { LanesService } from "./service.ts";

export type LanesFanoutRpc = Pick<HandlerTable, "lanes.compare" | "lanes.closeLosers">;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = [
  "lanes.compare",
  "lanes.closeLosers",
] as const satisfies readonly (keyof LanesFanoutRpc)[];

export function lanesFanoutRpc(service: Pick<LanesService, "compare" | "closeLosers">): LanesFanoutRpc {
  return {
    "lanes.compare": async (params, ctx) => service.compare(ctx.caller, params),
    "lanes.closeLosers": async (params, ctx) => service.closeLosers(ctx.caller, params),
  };
}
