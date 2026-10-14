import type { HandlerTable } from "@pap/contracts";
import type { TrustService } from "./service.ts";

export type TrustRpc = Pick<HandlerTable, "trust.status" | "trust.set">;

export function trustRpc(service: TrustService): TrustRpc {
  return {
    "trust.status": async ({ cwd }, ctx) => service.status(ctx.caller, cwd),
    "trust.set": async (params, ctx) => service.set(ctx.caller, params),
  };
}
