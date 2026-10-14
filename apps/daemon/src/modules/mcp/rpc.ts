import type { HandlerTable } from "@pap/contracts";
import type { McpService } from "./service.ts";

export type McpRpc = Pick<
  HandlerTable,
  | "mcp.overview"
  | "mcp.setEnabled"
  | "mcp.setExposure"
  | "mcp.setInProject"
  | "mcp.remove"
  | "mcp.undo"
  | "mcp.add"
  | "mcp.setCodemode"
  | "mcp.test"
>;

export function mcpRpc(service: McpService): McpRpc {
  return {
    "mcp.overview": async ({ cwd }, ctx) => service.overview(ctx.caller, cwd),
    "mcp.setEnabled": async (params, ctx) => service.setEnabled(ctx.caller, params),
    "mcp.setExposure": async (params, ctx) => service.setExposure(ctx.caller, params),
    "mcp.setInProject": async (params, ctx) => service.setInProject(ctx.caller, params),
    "mcp.remove": async (params, ctx) => service.remove(ctx.caller, params),
    "mcp.undo": async (params, ctx) => service.undo(ctx.caller, params),
    "mcp.add": async (params, ctx) => service.add(ctx.caller, params),
    "mcp.setCodemode": async (params, ctx) => service.setCodemode(ctx.caller, params),
    "mcp.test": async (params, ctx) => service.test(ctx.caller, params),
  };
}
