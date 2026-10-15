import type { HandlerTable } from "@pap/contracts";
import type { LanesService } from "./service.ts";

export type LanesCheckpointsRpc = Pick<HandlerTable, "lanes.checkpointStatus" | "lanes.restore">;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = [
  "lanes.checkpointStatus",
  "lanes.restore",
] as const satisfies readonly (keyof LanesCheckpointsRpc)[];

export function lanesCheckpointsRpc(
  service: Pick<LanesService, "checkpointStatus" | "restore">,
): LanesCheckpointsRpc {
  return {
    "lanes.checkpointStatus": async (params, ctx) => service.checkpointStatus(ctx.caller, params),
    "lanes.restore": async (params, ctx) => service.restore(ctx.caller, params),
  };
}
