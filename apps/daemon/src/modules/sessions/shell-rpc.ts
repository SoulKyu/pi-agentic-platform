import type { HandlerTable } from "@pap/contracts";
import type { SessionsService } from "./service.ts";

export type ShellRpc = Pick<HandlerTable, "subscribe.shell" | "sessions.listArchived">;

export function shellRpc(service: SessionsService): ShellRpc {
  return {
    // The key is the caller, never a param (M4R31); opening is this handler's only effect (R79).
    "subscribe.shell": async ({ after }, ctx) => ({
      sub: ctx.openSubscription("shell", ctx.caller.userId, after),
    }),
    "sessions.listArchived": async (params, ctx) => service.listArchived(ctx.caller, params),
  };
}
