import type { HandlerTable } from "@pap/contracts";
import type { FontsService } from "./service.ts";

export type FontsRpc = Pick<HandlerTable, "fonts.list" | "fonts.add" | "fonts.remove">;

/** Each handler decodes (the dispatcher did), makes one service call and lets typed errors through. */
export function fontsRpc(service: FontsService): FontsRpc {
  return {
    "fonts.list": async (_params, ctx) => service.list(ctx.caller),
    "fonts.add": async ({ family }, ctx) => service.add(ctx.caller, family),
    "fonts.remove": async ({ slug }, ctx) => service.remove(ctx.caller, slug),
  };
}
