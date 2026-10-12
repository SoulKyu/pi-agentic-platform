import type { HandlerTable } from "@pap/contracts";
import type { SettingsService } from "./service.ts";

export type SettingsRpc = Pick<HandlerTable, "settings.get" | "settings.set">;

export function settingsRpc(service: SettingsService): SettingsRpc {
  return {
    "settings.get": async ({ key }, ctx) => service.get(ctx.caller, key),
    "settings.set": async (params, ctx) => service.set(ctx.caller, params),
  };
}
