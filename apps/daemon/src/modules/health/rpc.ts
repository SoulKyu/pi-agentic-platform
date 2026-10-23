import { PapError } from "@pap/contracts";
import type { Handler, HandlerContext, ParamsOf } from "@pap/contracts";

// shortcut: the health console's real daemon RPC/stream is task 4 of the plan; these stubs keep
// the handler table exhaustive so the contracts of task 1 typecheck. Upgrade when task 4 lands.
export const healthRpc = {
  "ops.events.list": (async () => {
    throw new PapError("internal");
  }) satisfies Handler<"ops.events.list">,
  "subscribe.ops": (async ({ after }: ParamsOf<"subscribe.ops">, ctx: HandlerContext) => ({
    sub: ctx.openSubscription("ops", ctx.caller.userId, after),
  })) satisfies Handler<"subscribe.ops">,
};
