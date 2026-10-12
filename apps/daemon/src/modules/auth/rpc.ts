import type { HandlerTable } from "@pap/contracts";
import type { TokenService } from "./tokens.ts";

export type AuthRpc = Pick<HandlerTable, "auth.tokens.list" | "auth.tokens.create" | "auth.tokens.revoke">;

export function authRpc(tokens: TokenService): AuthRpc {
  return {
    "auth.tokens.list": async (_params, ctx) => ({ tokens: tokens.list(ctx.caller) }),
    "auth.tokens.create": async (params, ctx) => tokens.create(ctx.caller, params),
    "auth.tokens.revoke": async (params, ctx) => {
      tokens.revoke(ctx.caller, params.tokenId);
      return { ok: true };
    },
  };
}
