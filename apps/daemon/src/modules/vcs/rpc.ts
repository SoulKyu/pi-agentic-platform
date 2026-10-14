import type { HandlerTable } from "@pap/contracts";
import type { VcsService } from "./service.ts";

export type VcsRpc = Pick<HandlerTable, "subscribe.vcs" | "vcs.refresh" | "vcs.fileDiff">;

export function vcsRpc(service: VcsService): VcsRpc {
  return {
    // The refresh starts first and the subscription opens in the same tick, so its result arrives as a `status` event (M8R48).
    "subscribe.vcs": async ({ root, after }, ctx) => {
      const key = await service.prepareSubscription(ctx.caller, root);
      return { sub: ctx.openSubscription("vcs", key, after) };
    },
    "vcs.refresh": async ({ root }, ctx) => {
      await service.refresh(ctx.caller, root);
      return { ok: true as const };
    },
    "vcs.fileDiff": async (params, ctx) => service.fileDiff(ctx.caller, params),
  };
}
