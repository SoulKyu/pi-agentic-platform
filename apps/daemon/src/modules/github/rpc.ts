import type { HandlerTable } from "@pap/contracts";
import type { GithubService } from "./service.ts";

export type GithubAccountRpc = Pick<
  HandlerTable,
  "github.status" | "github.startCreate" | "github.authorizeUrl" | "github.disconnect" | "github.forget"
>;

/** Each handler makes one service call and lets typed errors through. */
export function githubAccountRpc(service: GithubService): GithubAccountRpc {
  return {
    "github.status": async (_params, ctx) => ({ status: await service.status(ctx.caller, ctx.origin) }),
    "github.startCreate": async (_params, ctx) => service.startCreate(ctx.caller, ctx.origin),
    "github.authorizeUrl": async (_params, ctx) => ({ url: service.authorizeUrl(ctx.caller, ctx.origin) }),
    "github.disconnect": async (_params, ctx) => {
      service.disconnect(ctx.caller);
      return { ok: true };
    },
    "github.forget": async (_params, ctx) => {
      service.forget(ctx.caller);
      return { ok: true };
    },
  };
}
