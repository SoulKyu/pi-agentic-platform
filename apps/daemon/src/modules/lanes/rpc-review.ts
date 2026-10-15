import type { HandlerTable } from "@pap/contracts";
import type { LaneReview } from "./review.ts";

export type LanesReviewRpc = Pick<
  HandlerTable,
  "lanes.review" | "lanes.turns" | "lanes.reviewState.get" | "lanes.reviewState.set"
>;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = [
  "lanes.review",
  "lanes.turns",
  "lanes.reviewState.get",
  "lanes.reviewState.set",
] as const satisfies readonly (keyof LanesReviewRpc)[];

export function lanesReviewRpc(review: LaneReview): LanesReviewRpc {
  return {
    "lanes.review": async (params, ctx) => review.review(ctx.caller, params),
    "lanes.turns": async (params, ctx) => review.turns(ctx.caller, params),
    "lanes.reviewState.get": async ({ laneId }, ctx) => review.stateGet(ctx.caller, laneId),
    "lanes.reviewState.set": async (params, ctx) => review.stateSet(ctx.caller, params),
  };
}
