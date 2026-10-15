import type { HandlerTable } from "@pap/contracts";
import type { ScriptRunner } from "./scripts.ts";

export type LanesScriptsRpc = Pick<HandlerTable, "lanes.scriptLog">;

/** The methods this file serves (pinned by rpc.test.ts). */
export const IMPLEMENTED = ["lanes.scriptLog"] as const satisfies readonly (keyof LanesScriptsRpc)[];

export function lanesScriptsRpc(runner: Pick<ScriptRunner, "readLog">): LanesScriptsRpc {
  return {
    "lanes.scriptLog": async ({ laneId, kind, offset }, ctx) =>
      runner.readLog(ctx.caller.userId, laneId, kind, offset),
  };
}
