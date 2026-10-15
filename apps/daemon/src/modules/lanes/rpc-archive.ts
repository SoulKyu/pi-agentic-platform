import type { HandlerTable } from "@pap/contracts";
import type { LanesService } from "./service.ts";

export type LanesArchiveRpc = Pick<HandlerTable, "lanes.archive" | "lanes.refresh" | "lanes.runScript">;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = [
  "lanes.archive",
  "lanes.refresh",
  "lanes.runScript",
] as const satisfies readonly (keyof LanesArchiveRpc)[];

export function lanesArchiveRpc(
  service: Pick<LanesService, "archive" | "refresh" | "runScript">,
): LanesArchiveRpc {
  return {
    "lanes.archive": async (params, ctx) => service.archive(ctx.caller, params),
    "lanes.refresh": async ({ laneId }, ctx) => service.refresh(ctx.caller, laneId),
    "lanes.runScript": async (params, ctx) => service.runScript(ctx.caller, params),
  };
}
