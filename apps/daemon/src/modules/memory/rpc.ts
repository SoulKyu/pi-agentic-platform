import type { HandlerTable } from "@pap/contracts";
import type { MemoryService } from "./service.ts";

export type MemoryRpc = Pick<
  HandlerTable,
  | "memory.status"
  | "memory.scopes"
  | "memory.list"
  | "memory.forget"
  | "memory.save"
  | "memory.staged"
  | "memory.decide"
>;

/** Each handler decodes (the dispatcher did), calls one service method and lets typed errors through (C §1.4.3). */
export function memoryRpc(memory: MemoryService): MemoryRpc {
  return {
    "memory.status": async (_params, ctx) => memory.status(ctx.caller),
    "memory.scopes": async (_params, ctx) => memory.scopes(ctx.caller),
    "memory.list": async ({ scope }, ctx) => memory.list(ctx.caller, scope),
    "memory.forget": async (params, ctx) => memory.forget(ctx.caller, params),
    "memory.save": async (params, ctx) => memory.save(ctx.caller, params),
    "memory.staged": async (_params, ctx) => memory.staged(ctx.caller),
    "memory.decide": async (params, ctx) => memory.decide(ctx.caller, params),
  };
}
