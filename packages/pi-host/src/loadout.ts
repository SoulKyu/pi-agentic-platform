import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  MAX_LOADOUT_TOOLS,
  ModelSummary,
  type SessionLoadout,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@pap/contracts";
import { logLineOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";
import { presetOf } from "./tool-presets.ts";

const MAX_NAME_CHARS = 256;

/** The fields of a Pi model the menu shows, or null when a field would not pass the contract (a client could not read it). */
export function summaryOf(model: {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  input?: readonly string[];
}): ModelSummary | null {
  const parsed = ModelSummary.safeParse({
    provider: model.provider,
    id: model.id,
    name: (model.name ?? model.id).slice(0, MAX_NAME_CHARS),
    reasoning: model.reasoning === true,
    ...(Number.isInteger(model.contextWindow) && (model.contextWindow ?? 0) > 0
      ? { contextWindow: model.contextWindow }
      : {}),
    images: model.input?.includes("image") === true,
  });
  return parsed.success ? parsed.data : null;
}

const isLevel = (level: string): level is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(level);

/** What the session opened with, as Pi's trust resolver answered (M7R105): a later decision applies at the next open. */
export interface ProjectTrustFacts {
  readonly required: boolean;
  readonly trusted: boolean;
}
const projectTrust = new WeakMap<AgentSession, ProjectTrustFacts>();
export const rememberProjectTrust = (session: AgentSession, facts: ProjectTrustFacts): void => {
  projectTrust.set(session, facts);
};

/** What the worker tells the daemon about the session's model, reasoning level and tools (M7R44, M7R45). */
export function loadoutOf(session: AgentSession): SessionLoadout {
  const trust = projectTrust.get(session);
  const tools = session.getActiveToolNames();
  const level = session.thinkingLevel;
  return {
    model: session.model ? summaryOf(session.model) : null,
    thinkingLevel: isLevel(level) ? level : "off",
    levels: session.getAvailableThinkingLevels().filter(isLevel),
    preset: presetOf(session),
    tools: tools.slice(0, MAX_LOADOUT_TOOLS).map((name) => name.slice(0, MAX_NAME_CHARS)),
    toolsTruncated: tools.length > MAX_LOADOUT_TOOLS,
    ...(trust ? { projectTrust: { required: trust.required, trusted: trust.trusted } } : {}),
  };
}

export const loadoutRecord = (session: AgentSession): Outbound => ({
  type: "loadout",
  loadout: loadoutOf(session),
});

/**
 * An extension may switch models or the level on its own (`pi.setModel`, a command): the daemon hears of it from here.
 * The session does not exist while Pi builds it, so the extension asks for it when an event comes.
 */
export function createLoadoutWatcher(
  send: (record: Outbound) => unknown,
  session: () => AgentSession | undefined,
): InlineExtension {
  const tell = (): void => {
    const current = session();
    if (!current) return;
    try {
      send(loadoutRecord(current));
    } catch (error) {
      process.stderr.write(`pi-host: loadout not sent: ${logLineOf(error)}\n`);
    }
  };
  return {
    name: "pap-loadout",
    hidden: true,
    factory: (pi) => {
      pi.on("model_select", tell);
      pi.on("thinking_level_select", tell);
    },
  };
}
