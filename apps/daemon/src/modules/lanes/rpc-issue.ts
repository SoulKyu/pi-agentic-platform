import type { HandlerTable } from "@pap/contracts";
import type { Issues } from "./issue.ts";

export type LanesIssueRpc = Pick<HandlerTable, "lanes.issue">;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = ["lanes.issue"] as const satisfies readonly (keyof LanesIssueRpc)[];

export function lanesIssueRpc(issues: Issues): LanesIssueRpc {
  return { "lanes.issue": async (params, ctx) => issues.view(ctx.caller, params) };
}
