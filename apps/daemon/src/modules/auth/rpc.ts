import type { HandlerTable } from "@pap/contracts";
import type { Devices } from "./devices.ts";
import type { PasskeyManager } from "./passkey-manage.ts";
import type { TokenService } from "./tokens.ts";

export type AuthRpc = Pick<
  HandlerTable,
  | "auth.tokens.list"
  | "auth.tokens.create"
  | "auth.tokens.revoke"
  | "auth.devices.list"
  | "auth.devices.revoke"
  | "auth.devices.revokeOthers"
  | "auth.passkeys.list"
  | "auth.passkeys.remove"
>;

export function authRpc(tokens: TokenService, devices: Devices, passkeys: PasskeyManager): AuthRpc {
  return {
    "auth.tokens.list": async (_params, ctx) => ({ tokens: tokens.list(ctx.caller) }),
    "auth.tokens.create": async (params, ctx) => tokens.create(ctx.caller, params),
    "auth.tokens.revoke": async (params, ctx) => {
      tokens.revoke(ctx.caller, params.tokenId);
      return { ok: true };
    },
    "auth.devices.list": async (_params, ctx) => ({ devices: devices.list(ctx.caller) }),
    "auth.devices.revoke": async (params, ctx) => {
      devices.revoke(ctx.caller, params.deviceId);
      return { ok: true };
    },
    "auth.devices.revokeOthers": async (_params, ctx) => devices.revokeOthers(ctx.caller),
    "auth.passkeys.list": async (_params, ctx) => ({ passkeys: passkeys.list(ctx.caller) }),
    "auth.passkeys.remove": async (params, ctx) => passkeys.remove(ctx.caller, params.passkeyId),
  };
}
