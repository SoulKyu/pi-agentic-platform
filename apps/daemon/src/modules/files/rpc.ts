import type { HandlerTable } from "@pap/contracts";
import type { FilesService } from "./service.ts";

export type FilesRpc = Pick<HandlerTable, "files.list" | "files.read" | "files.search" | "files.write">;

export function filesRpc(service: FilesService): FilesRpc {
  return {
    "files.list": async (params, ctx) => service.list(ctx.caller, params),
    "files.read": async (params, ctx) => service.read(ctx.caller, params),
    "files.search": async (params, ctx) => service.search(ctx.caller, params),
    "files.write": async (params, ctx) => service.write(ctx.caller, params),
  };
}
