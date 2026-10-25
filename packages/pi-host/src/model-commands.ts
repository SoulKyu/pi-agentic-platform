import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  MAX_LISTED_MODELS,
  MODEL_NOT_OFFERED,
  MODEL_PROVIDER_UNKNOWN,
  type ModelSummary,
  type ThinkingLevel,
  WORKER_BUSY,
} from "@pap/contracts/pi-host";
import { freshAvailable } from "./available-models.ts";
import { messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";
import { loadoutRecord, summaryOf } from "./loadout.ts";

type Send = (record: Outbound) => unknown;
type PiModel = NonNullable<AgentSession["model"]>;

const ok = (send: Send, id: string, command: string, data?: unknown) =>
  send({ type: "response", id, command, success: true, ...(data === undefined ? {} : { data }) });
const failed = (send: Send, id: string, command: string, error: unknown) =>
  send({ type: "response", id, command, success: false, error: messageOf(error) });

const listedModels = async (session: AgentSession): Promise<readonly PiModel[]> =>
  (await freshAvailable(session.modelRuntime, session.settingsManager, session.scopedModels, session.isIdle))
    .models;

/** The list as JSON must stay well inside the 1 MiB frame (names are escaped, up to six bytes a character). */
const MAX_LIST_BYTES = 600_000;

export async function handleGetAvailableModels(
  session: AgentSession,
  command: { id: string },
  send: Send,
): Promise<void> {
  try {
    const summaries: ModelSummary[] = [];
    let truncated = false;
    let bytes = 0;
    for (const model of await listedModels(session)) {
      const summary = summaryOf(model);
      if (!summary) continue;
      const size = Buffer.byteLength(JSON.stringify(summary)) + 1;
      if (summaries.length >= MAX_LISTED_MODELS || bytes + size > MAX_LIST_BYTES) {
        truncated = true;
        break;
      }
      bytes += size;
      summaries.push(summary);
    }
    const current = session.model;
    send(loadoutRecord(session));
    ok(send, command.id, "get_available_models", {
      models: summaries,
      truncated,
      current: current ? { provider: current.provider, id: current.id } : null,
    });
  } catch (error) {
    failed(send, command.id, "get_available_models", error);
  }
}

// A model change mid-run is refused (M7R43). The daemon checks its own view first; here `isIdle` is read twice: at the
// start, and again right before the switch, because listing the models awaits and a prompt may start a run meanwhile.
const busy = (send: Send, id: string): void =>
  void send({ type: "response", id, command: "set_model", success: false, error: WORKER_BUSY });

export async function handleSetModel(
  session: AgentSession,
  command: { id: string; provider: string; modelId: string },
  send: Send,
): Promise<void> {
  // A function, so the compiler does not take the second read for the first one's answer.
  const running = (): boolean => session.isIdle === false;
  if (running()) return busy(send, command.id);
  try {
    const wanted = (await listedModels(session)).find(
      (model) => model.provider === command.provider && model.id === command.modelId,
    );
    // A provider this runtime lacks is said apart: in Chat only, with no extension loaded, that is the reason.
    if (!wanted)
      throw new Error(
        session.modelRuntime.getProvider(command.provider) ? MODEL_NOT_OFFERED : MODEL_PROVIDER_UNKNOWN,
      );
    // Nothing is awaited between this check and the call that switches.
    if (running()) return busy(send, command.id);
    // No `persist`: the pick is the session's, settings.json is the owner's (M7R42).
    await session.setModel(wanted);
    send(loadoutRecord(session));
    ok(send, command.id, "set_model");
  } catch (error) {
    failed(send, command.id, "set_model", error);
  }
}

/** Allowed at any time: Pi reads the level again for each model request, so a run in flight uses it from its next one. */
export function handleSetThinking(
  session: AgentSession,
  command: { id: string; level: ThinkingLevel },
  send: Send,
): void {
  try {
    // Pi clamps a level the model lacks to the nearest one it has; the loadout carries what it settled on.
    session.setThinkingLevel(command.level);
    send(loadoutRecord(session));
    ok(send, command.id, "set_thinking_level");
  } catch (error) {
    failed(send, command.id, "set_thinking_level", error);
  }
}
