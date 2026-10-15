import type { HandlerTable } from "@pap/contracts";
import type { LaneSuggest } from "./suggest.ts";

export type LanesSuggestRpc = Pick<HandlerTable, "lanes.suggestCommit">;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = ["lanes.suggestCommit"] as const satisfies readonly (keyof LanesSuggestRpc)[];

export function lanesSuggestRpc(suggest: LaneSuggest): LanesSuggestRpc {
  return { "lanes.suggestCommit": async (params, ctx) => suggest.suggest(ctx.caller, params) };
}
