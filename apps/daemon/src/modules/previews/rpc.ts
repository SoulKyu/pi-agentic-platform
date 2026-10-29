import { type Caller, type HandlerTable, PapError, PREVIEWS_BROWSER_ONLY } from "@pap/contracts";
import type { PreviewsService } from "./service.ts";

export type PreviewsRpc = Pick<
  HandlerTable,
  | "subscribe.previews"
  | "previews.list"
  | "previews.stop"
  | "previews.restart"
  | "previews.startProject"
  | "previews.logs"
  | "previews.open"
  | "previews.renew"
  | "previews.close"
  | "previews.artifact"
>;

/** UX2-R32: minting, renewing and closing belong to the owner's own browser; an API token is refused before anything else. */
function browserOnly(method: string, caller: Caller): void {
  if (caller.kind === "token" && PREVIEWS_BROWSER_ONLY.has(method)) throw new PapError("forbidden");
}

export function previewsRpc(service: PreviewsService): PreviewsRpc {
  return {
    "subscribe.previews": async (params, ctx) => ({
      sub: ctx.openSubscription("previews", ctx.caller.userId, params.after),
    }),
    "previews.list": (params, ctx) => service.list(ctx.caller, params.box),
    "previews.stop": async (params, ctx) => {
      await service.stop(ctx.caller, params.box, params.name);
      return {};
    },
    "previews.restart": (params, ctx) => service.restart(ctx.caller, params.box, params.name),
    "previews.startProject": (params, ctx) => service.startProject(ctx.caller, params),
    "previews.logs": (params, ctx) => service.logs(ctx.caller, params.box, params.name),
    "previews.open": async (params, ctx) => {
      browserOnly("previews.open", ctx.caller);
      return service.open(ctx.caller, params.box, params.name);
    },
    "previews.renew": async (params, ctx) => {
      browserOnly("previews.renew", ctx.caller);
      return service.renew(ctx.caller, params.lease);
    },
    "previews.close": async (params, ctx) => {
      browserOnly("previews.close", ctx.caller);
      await service.close(ctx.caller, params.lease);
      return {};
    },
    "previews.artifact": async (params, ctx) => {
      browserOnly("previews.artifact", ctx.caller);
      return service.artifact(ctx.caller, params);
    },
  };
}
