import type { HandlerTable } from "@pap/contracts";
import type { SearchService } from "./service.ts";

export type SearchRpc = Pick<HandlerTable, "search.query">;

export function searchRpc(service: SearchService): SearchRpc {
  return {
    "search.query": async (params, ctx) => service.query(ctx.caller, params),
  };
}
