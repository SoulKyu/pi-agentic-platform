import type { HandlerTable } from "@pap/contracts";
import type { AgentFilesService } from "./agent-files-service.ts";

export type AgentFilesRpc = Pick<HandlerTable, "agents.files.list" | "agents.files.remove">;

/** The two file methods of `agents-vm-methods.ts`: decode (the contract bounds the path), one service call. */
export function agentFilesRpc(service: AgentFilesService): AgentFilesRpc {
  return {
    "agents.files.list": async ({ agentId }, ctx) => service.list(ctx.caller, agentId),
    "agents.files.remove": async ({ agentId, path }, ctx) => service.remove(ctx.caller, agentId, path),
  };
}
