import type { HandlerTable } from "@pap/contracts";
import type { LaneConfig } from "./preview.ts";

export type LanesConfigRpc = Pick<HandlerTable, "lanes.preview" | "lanes.approveScripts">;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = [
  "lanes.preview",
  "lanes.approveScripts",
] as const satisfies readonly (keyof LanesConfigRpc)[];

export function lanesConfigRpc(service: LaneConfig): LanesConfigRpc {
  return {
    "lanes.preview": async ({ projectRoot }, ctx) => service.preview(ctx.caller, projectRoot),
    "lanes.approveScripts": async (params, ctx) => service.approveScripts(ctx.caller, params),
  };
}
