import type { HandlerTable } from "@pap/contracts";
import type { Inbox } from "./service.ts";

export type InboxRpc = Pick<HandlerTable, "inbox.markRead" | "inbox.list" | "subscribe.inbox">;

/** The owner is the caller the transport stamped, never a param; each handler is one service call. */
export function inboxRpc(inbox: Pick<Inbox, "markRead" | "list">): InboxRpc {
  return {
    "inbox.markRead": async (params, ctx) => inbox.markRead(ctx.caller.userId, params),
    "inbox.list": async ({ before, filter }, ctx) => inbox.list(ctx.caller.userId, before, filter),
    "subscribe.inbox": async ({ after }, ctx) => ({
      sub: ctx.openSubscription("inbox", ctx.caller.userId, after),
    }),
  };
}
