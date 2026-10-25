import {
  type AvailableModels,
  AvailableModelsData,
  type Caller,
  type CommandInput,
  PapError,
  SessionCommandsData,
  type ThinkingLevel,
  type ToolPreset,
} from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import { refusalOf } from "./live-commands.ts";
import type { LiveSession } from "./live-types.ts";
import { type SessionRow, type SessionsStore, storedPresetOf } from "./store.ts";
import { clip } from "./worker-text.ts";

export interface SessionModelsDeps {
  owned(sessionId: string, caller: Caller): SessionRow;
  ensureLive(row: SessionRow): Promise<LiveSession>;
  /** A prompt of the session waits in the lane hooks: it is busy for a model or tool change too. */
  waiting(sessionId: string): boolean;
  readonly logger: Logger;
  readonly store: Pick<SessionsStore, "toolPreset" | "setToolPreset" | "setOwnerPreset">;
  /** The session's worker if one is up or being started (a start in progress is waited for); none for a cold session. */
  running(sessionId: string): Promise<LiveSession | null>;
  /** The stored preset changed: the worker is sent the rules that follow from it. */
  presetChanged(row: SessionRow): void;
  /** An agent thread's preset never goes wider than its start-time profile's (W5-R26). */
  clampPreset(row: SessionRow, preset: ToolPreset): ToolPreset;
  /** A member sees only the providers the owner shares (M14); the owner sees all. */
  readonly providers: {
    sessionModels(userId: string, data: AvailableModelsData): Promise<AvailableModelsData>;
    available(caller: Caller): Promise<AvailableModels>;
  };
}

export interface SessionModels {
  /**
   * The models the session's own runtime offers, in Pi's order (M7R41). A cold session's worker is started for it, so
   * capacity applies and extension providers and the project's trust are what the session really has.
   */
  models(sessionId: string, caller: Caller): Promise<AvailableModelsData>;
  /** The models to pick from before a session exists. It names no folder, so no host helper reads a project (M14). */
  availableModels(caller: Caller): Promise<AvailableModels>;
  /** The slash commands of the session's own runtime (M7R119). A cold session's worker is started for it, like `models`. */
  commands(sessionId: string, caller: Caller): Promise<SessionCommandsData>;
  /** Switches the session's model; `session_busy` while a run goes on (M7R43). Never written to Pi's settings (M7R42). */
  setModel(input: { sessionId: string; provider: string; modelId: string }, caller: Caller): Promise<void>;
  /** Sets the reasoning level, allowed at any time: a run in flight uses it from its next model request. */
  setThinking(input: { sessionId: string; level: ThinkingLevel }, caller: Caller): Promise<void>;
  /**
   * Changes the session's tool preset (M7R77). A cold session only stores it. A live one must be idle (`session_busy`):
   * between presets other than `chat` the worker applies it in place; crossing the `chat` boundary stores it and releases
   * the worker, and the next start opens with the new preset. Nothing is stored when the change is refused: busy, or
   * refused by the worker.
   */
  setTools(input: { sessionId: string; preset: ToolPreset }, caller: Caller): Promise<void>;
}

export function createSessionModels(deps: SessionModelsDeps): SessionModels {
  // The worker's text is untrusted: it is logged clipped and never returned (R66, M2R87).
  const refused = (command: CommandInput["type"], error: string): PapError => {
    deps.logger.warn("command_refused", { command, error: clip(error) });
    return new PapError(refusalOf(command, error));
  };
  async function ask(sessionId: string, caller: Caller, input: CommandInput, mustBeIdle: boolean) {
    const row = deps.owned(sessionId, caller);
    const session = await deps.ensureLive(row);
    // Nothing is awaited between this check and the send, so no prompt can slip in between (M2-RT-08).
    if (mustBeIdle && (session.busy() || deps.waiting(sessionId))) throw new PapError("session_busy");
    const answer = await session.command(input);
    if (!answer.ok) throw refused(input.type, answer.error);
    return answer.data;
  }
  return {
    async models(sessionId, caller) {
      const data = await ask(sessionId, caller, { type: "get_available_models" }, false);
      const parsed = AvailableModelsData.safeParse(data);
      if (!parsed.success) {
        deps.logger.warn("models_answer_unreadable", { sessionId });
        throw new PapError("command_failed");
      }
      return deps.providers.sessionModels(caller.userId, parsed.data);
    },
    availableModels: (caller) => deps.providers.available(caller),
    async commands(sessionId, caller) {
      const data = await ask(sessionId, caller, { type: "get_commands" }, false);
      const parsed = SessionCommandsData.safeParse(data);
      if (!parsed.success) {
        deps.logger.warn("commands_answer_unreadable", { sessionId });
        throw new PapError("command_failed");
      }
      return parsed.data;
    },
    async setModel({ sessionId, provider, modelId }, caller) {
      await ask(sessionId, caller, { type: "set_model", provider, modelId }, true);
    },
    async setThinking({ sessionId, level }, caller) {
      await ask(sessionId, caller, { type: "set_thinking_level", level }, false);
    },
    async setTools({ sessionId, preset: requested }, caller) {
      const row = deps.owned(sessionId, caller);
      const worker = await deps.running(row.id);
      // After the wait: a start in progress has set the profile its worker keeps, the one that clamps (W5-R26).
      const preset = deps.clampPreset(row, requested);
      // Written only once the change takes effect. The owner's choice is kept apart from the profile's, so a restart
      // narrows again and never forgets it; a refused change leaves both as they were (W5-R28).
      const keep = () => {
        if (row.agentRole === "thread") deps.store.setOwnerPreset(row.id, requested);
        deps.store.setToolPreset(row.id, storedPresetOf(preset));
      };
      if (!worker || worker.stopping()) {
        // The next worker reads the stored preset when it starts.
        keep();
        return;
      }
      // Nothing is awaited between this check and the send, so no prompt can slip in between (M2-RT-08).
      if (worker.busy() || deps.waiting(row.id)) throw new PapError("session_busy");
      const crossesChat = (deps.store.toolPreset(row.id) === "chat") !== (preset === "chat");
      if (crossesChat) {
        keep();
        await worker.stop();
        return;
      }
      const answer = await worker.command({ type: "set_tools", preset });
      if (!answer.ok) throw refused("set_tools", answer.error);
      keep();
      deps.presetChanged(row);
    },
  };
}
