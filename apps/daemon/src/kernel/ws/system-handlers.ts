import type { HandlerTable } from "@pap/contracts";
import type { Clock } from "../clock.ts";

export function systemHandlers(clock: Clock): Pick<HandlerTable, "system.ping" | "unsubscribe"> {
  return {
    "system.ping": async () => ({ now: clock.now() }),
    unsubscribe: async ({ sub }, ctx) => {
      ctx.closeSubscription(sub);
      return { ok: true as const };
    },
  };
}
