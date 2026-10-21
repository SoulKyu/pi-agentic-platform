import type { AgentRailState, AgentSummary } from "@pap/contracts";
import type { Translate } from "../../i18n/index.ts";
import { agentLifecycle } from "./agent-lifecycle.ts";

/** Where an agent's avatar leads. Structural, so the shell's `ItemRef` accepts it without this feature importing it. */
export type AgentTarget =
  { readonly kind: "agent"; readonly id: string } | { readonly kind: "settings"; readonly section: "agents" };

/** The badge: the count, `99+` past 99 (M11R108). */
export const badgeText = (count: number): string => (count > 99 ? "99+" : String(count));

const PRESENCE = {
  needs_input: "waiting",
  running: "running",
  failed: "waiting",
  paused: "idle",
  idle: "idle",
  quarantined: "idle",
} as const satisfies Record<AgentRailState, "running" | "waiting" | "idle">;

/** The presence dot's tone. The state word is always in the name and the tooltip: the dot is never the only signal. */
export const railPresence = (state: AgentRailState) => PRESENCE[state];

export const unreadLabel = (agent: AgentSummary, t: Translate): string =>
  t("shell.agent.unread", { count: badgeText(agent.unread) });

/**
 * The state word of the shared vocabulary, from the summary alone (the rail knows no session or VM phase): none for an
 * agent that is ready, which is the default and not a badge.
 */
const stateWord = (agent: AgentSummary, t: Translate): readonly string[] => {
  const lifecycle = agentLifecycle(agent, null, null);
  return lifecycle === null ? [] : [t(`shell.agent.state.${lifecycle}`)];
};

/** "paused · profile unreadable": the state word, and the profile problem when there is one (phone list). */
export const stateWords = (agent: AgentSummary, t: Translate): string =>
  [...stateWord(agent, t), ...(agent.unreadable ? [t("shell.agent.profileUnreadable")] : [])].join(" · ");

/** "needs input · 3 unread": the state words and, when there is one, the unread count. */
export const railDetail = (agent: AgentSummary, t: Translate): string =>
  [stateWords(agent, t), ...(agent.unread > 0 ? [unreadLabel(agent, t)] : [])].join(" · ");

/** The accessible name and the tooltip: "Atlas, needs input, 3 unread" (M11R108). An unreadable profile says so and where the fix is. */
export function railName(agent: AgentSummary, t: Translate): string {
  return [
    agent.name,
    ...stateWord(agent, t),
    ...(agent.unread > 0 ? [unreadLabel(agent, t)] : []),
    ...(agent.unreadable ? [t("shell.agent.unreadable")] : []),
  ].join(", ");
}

/** The n-th agent in creation order (1-based), the order the daemon sends: shortcuts stay stable (M11R108). */
export const agentAt = (agents: readonly AgentSummary[], n: number): AgentSummary | null =>
  Number.isInteger(n) && n >= 1 ? (agents[n - 1] ?? null) : null;

/**
 * The next (`1`) or previous (`-1`) agent with unread activity after the active one, wrapping round. Never the active
 * agent itself; with none active the search starts from the edge. Null when no other agent has unread activity.
 */
export function nextUnread(
  agents: readonly AgentSummary[],
  activeId: string | null,
  step: 1 | -1,
): AgentSummary | null {
  const from = agents.findIndex((agent) => agent.id === activeId);
  for (let offset = 1; offset <= agents.length; offset += 1) {
    const at = from === -1 ? (step === 1 ? offset - 1 : agents.length - offset) : from + step * offset;
    const candidate = agents[((at % agents.length) + agents.length) % agents.length];
    if (candidate !== undefined && candidate.id !== activeId && candidate.unread > 0) return candidate;
  }
  return null;
}

/** An unreadable profile cannot start, so its avatar leads to the place where it is fixed (M11R108, Task 9 review). */
export const agentTarget = (agent: AgentSummary): AgentTarget =>
  agent.unreadable ? { kind: "settings", section: "agents" } : { kind: "agent", id: agent.id };
