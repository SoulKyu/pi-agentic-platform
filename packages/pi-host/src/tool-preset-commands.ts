import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import { type ToolPreset, WORKER_BUSY } from "@pap/contracts/pi-host";
import { logLineOf, messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";
import { loadoutRecord } from "./loadout.ts";
import { applyPreset, presetOf } from "./tool-presets.ts";

type Send = (record: Outbound) => unknown;
const respond = (send: Send, id: string, success: boolean, error?: string) =>
  send({ type: "response", id, command: "set_tools", success, ...(error === undefined ? {} : { error }) });

/**
 * `set_tools`: idle only, and never across the `chat` boundary (the extensions are loaded or not at open, so the daemon
 * restarts the worker for that). The next turn uses the new tools; nothing running is changed.
 */
export function handleSetTools(
  session: AgentSession,
  command: { id: string; preset: ToolPreset },
  send: Send,
): void {
  if (session.isIdle === false) {
    respond(send, command.id, false, WORKER_BUSY);
    return;
  }
  if ((presetOf(session) === "chat") !== (command.preset === "chat")) {
    respond(send, command.id, false, "the chat preset needs a new worker");
    return;
  }
  try {
    applyPreset(session, command.preset, { restore: true });
    send(loadoutRecord(session));
    respond(send, command.id, true);
  } catch (error) {
    respond(send, command.id, false, messageOf(error));
  }
}

/**
 * Puts the preset back after anything that rewrites the active tools: `/reload`, a branch switch, a resumed transcript,
 * `tool_search` loading a tool (M7R75). The policy blocks a coding tool the preset leaves out whatever the active set says,
 * so this keeps the model's tool list honest; it is not what keeps the session read-only.
 */
export function createPresetKeeper(session: () => AgentSession | undefined): InlineExtension {
  return {
    name: "pap-presets",
    hidden: true,
    factory: (pi) => {
      const reapply = (): void => {
        const current = session();
        if (!current) return;
        try {
          applyPreset(current, presetOf(current));
        } catch (error) {
          process.stderr.write(`pi-host: preset not re-applied: ${logLineOf(error)}\n`);
        }
      };
      pi.on("session_start", reapply);
      pi.on("session_tree", reapply);
      pi.on("before_agent_start", reapply);
      pi.on("turn_start", reapply);
    },
  };
}
