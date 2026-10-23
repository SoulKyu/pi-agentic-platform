import { PapError } from "@pap/contracts";
import type { Handler, HandlerContext, ParamsOf } from "@pap/contracts";

// shortcut: the health console's daemon side is task 2 of the plan; these stubs keep the
// handler table exhaustive so the contracts of task 1 typecheck. Upgrade when task 2 lands.
export const healthRpc = {
  "ops.events.list": (async () => {
    throw new PapError("internal");
  }) satisfies Handler<"ops.events.list">,
  "subscribe.ops": (async (_params: ParamsOf<"subscribe.ops">, ctx: HandlerContext) => ({
    sub: ctx.openSubscription("ops", ctx.caller.userId, undefined),
  })) satisfies Handler<"subscribe.ops">,
};
