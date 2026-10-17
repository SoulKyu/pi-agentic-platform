import { PapError, type HandlerTable } from "@pap/contracts";
import type { Profiles } from "./profiles.ts";

export type SubagentsRpc = Pick<HandlerTable, "subagents.profiles" | "subagents.cancel">;

export function subagentsRpc(
  profiles: Profiles,
  cancelRun: (ownerId: string, runId: string) => boolean,
): SubagentsRpc {
  return {
    "subagents.profiles": async ({ sessionId }, ctx) => profiles.list(ctx.caller, sessionId),
    "subagents.cancel": async ({ runId }, ctx) => {
      if (!cancelRun(ctx.caller.userId, runId)) throw new PapError("not_found");
      return { ok: true };
    },
  };
}
