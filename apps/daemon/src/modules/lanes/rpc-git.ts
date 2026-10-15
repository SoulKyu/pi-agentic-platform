import type { HandlerTable } from "@pap/contracts";
import type { LanesService } from "./service.ts";

export type LanesGitRpc = Pick<
  HandlerTable,
  "lanes.commit" | "lanes.push" | "lanes.prCreate" | "lanes.prRefresh"
>;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = [
  "lanes.commit",
  "lanes.push",
  "lanes.prCreate",
  "lanes.prRefresh",
] as const satisfies readonly (keyof LanesGitRpc)[];

export function lanesGitRpc(
  service: Pick<LanesService, "commit" | "push" | "prCreate" | "prRefresh">,
): LanesGitRpc {
  return {
    "lanes.commit": async (params, ctx) => service.commit(ctx.caller, params),
    "lanes.push": async (params, ctx) => service.push(ctx.caller, params),
    "lanes.prCreate": async (params, ctx) => service.prCreate(ctx.caller, params),
    "lanes.prRefresh": async (params, ctx) => service.prRefresh(ctx.caller, params),
  };
}
