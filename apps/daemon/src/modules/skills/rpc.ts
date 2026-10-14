import type { HandlerTable } from "@pap/contracts";
import type { SkillsService } from "./service.ts";

export type SkillsRpc = Pick<
  HandlerTable,
  | "skills.list"
  | "skills.setInvocation"
  | "skills.search"
  | "skills.install"
  | "plugins.list"
  | "plugins.install"
  | "plugins.remove"
  | "plugins.update"
  | "plugins.setEnabled"
>;

export function skillsRpc(service: SkillsService): SkillsRpc {
  return {
    "skills.list": async ({ cwd }, ctx) => service.list(ctx.caller, cwd),
    "skills.setInvocation": async (params, ctx) => service.setInvocation(ctx.caller, params),
    "skills.search": async ({ query }, ctx) => service.search(ctx.caller, query),
    "skills.install": async (params, ctx) => service.install(ctx.caller, params),
    "plugins.list": async ({ cwd }, ctx) => service.listPlugins(ctx.caller, cwd),
    "plugins.install": async (params, ctx) => service.installPlugin(ctx.caller, params),
    "plugins.remove": async (params, ctx) => service.removePlugin(ctx.caller, params),
    "plugins.update": async (params, ctx) => service.updatePlugins(ctx.caller, params),
    "plugins.setEnabled": async (params, ctx) => service.setPluginsEnabled(ctx.caller, params),
  };
}
