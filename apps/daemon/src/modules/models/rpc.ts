import type { HandlerTable } from "@pap/contracts";
import type { ModelsService } from "./service.ts";

export type ModelsRpc = Pick<
  HandlerTable,
  | "models.overview"
  | "models.available"
  | "models.setDefault"
  | "models.setDefaultThinking"
  | "models.setEnabled"
  | "models.refreshCatalog"
  | "models.config.get"
  | "models.config.save"
  | "models.provider.get"
  | "models.provider.save"
  | "models.provider.remove"
  | "models.discover"
  | "models.test"
  | "models.pricing"
  | "models.usage"
  | "models.extensions"
  | "models.login"
  | "models.loginAnswer"
  | "models.loginCancel"
  | "models.cancelLogin"
  | "subscribe.login"
  | "models.setApiKey"
  | "models.logout"
>;

export function modelsRpc(service: ModelsService): ModelsRpc {
  return {
    "models.overview": async ({ cwd }, ctx) => service.overview(ctx.caller, cwd),
    "models.available": async ({ cwd }, ctx) => service.available(ctx.caller, cwd),
    "models.setDefault": async (params, ctx) => service.setDefault(ctx.caller, params),
    "models.setDefaultThinking": async (params, ctx) => service.setDefaultThinking(ctx.caller, params),
    "models.setEnabled": async (params, ctx) => service.setEnabled(ctx.caller, params),
    "models.refreshCatalog": async () => service.refreshCatalog(),
    "models.config.get": async () => service.configGet(),
    "models.config.save": async (params, ctx) => service.configSave(ctx.caller, params),
    "models.provider.get": async (params, ctx) => service.providerForm.get(ctx.caller, params),
    "models.provider.save": async (params, ctx) => service.providerForm.save(ctx.caller, params),
    "models.provider.remove": async (params, ctx) => service.providerForm.remove(ctx.caller, params),
    "models.discover": async (params, ctx) => service.discover(ctx.caller, params),
    "models.test": async (params, ctx) => service.test(ctx.caller, params),
    "models.pricing": async (params, ctx) => service.pricing(ctx.caller, params),
    "models.usage": async (params, ctx) => service.usage(ctx.caller, params),
    "models.extensions": async () => service.extensions(),
    "models.login": async (params, ctx) => service.login(ctx.caller, params),
    "models.loginAnswer": async (params, ctx) => service.loginAnswer(ctx.caller, params),
    "models.loginCancel": async (params, ctx) => service.loginCancel(ctx.caller, params),
    "models.cancelLogin": async (params, ctx) => service.cancelLogin(ctx.caller, params),
    "subscribe.login": async ({ flowId, after }, ctx) =>
      service.subscribeLogin(ctx.caller, flowId, (key) => ctx.openSubscription("login", key, after)),
    "models.setApiKey": async (params, ctx) => service.setApiKey(ctx.caller, params),
    "models.logout": async (params, ctx) => service.logout(ctx.caller, params),
  };
}
