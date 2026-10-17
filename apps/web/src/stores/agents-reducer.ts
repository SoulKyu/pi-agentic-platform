import {
  AGENT_LIMITS,
  AGENTS_STREAM_LIMITS,
  type AgentRequestView,
  AgentsStreamEvent,
  type AgentSummary,
} from "@pap/contracts";
import type { RpcErrorCode } from "../runtime/index.ts";

export interface AgentsView {
  readonly loaded: boolean;
  /** In the order the daemon sent them (oldest agent first); at most 32. */
  readonly agents: readonly AgentSummary[];
  /** The requests that wait for the owner, oldest first; at most 200. */
  readonly requests: readonly AgentRequestView[];
  /** The daemon left requests out of the snapshot, or one arrived past the cap. */
  readonly truncated: boolean;
  /** Why the stream was refused; a snapshot clears it. */
  readonly failed: RpcErrorCode | null;
  /** Events this build could not read, or that went past a cap: skipped, never fatal. */
  readonly skipped: number;
  /** Per agent: how many times a card of its thread was written or moved. The open agent tab reads its cards again when it rises. */
  readonly cardTicks: Readonly<Record<string, number>>;
}

export const EMPTY_AGENTS: AgentsView = {
  loaded: false,
  agents: [],
  requests: [],
  truncated: false,
  failed: null,
  skipped: 0,
  cardTicks: {},
};

export const agentById = (view: AgentsView, id: string): AgentSummary | undefined =>
  view.agents.find((agent) => agent.id === id);

export const requestsOf = (view: AgentsView, agentId: string): AgentRequestView[] =>
  view.requests.filter((request) => request.agentId === agentId);

const skip = (view: AgentsView): AgentsView => ({ ...view, skipped: view.skipped + 1 });

export function reduceAgents(view: AgentsView, event: unknown): AgentsView {
  const parsed = AgentsStreamEvent.safeParse(event);
  if (!parsed.success) return skip(view);
  const next = parsed.data;
  switch (next.kind) {
    case "snapshot":
      return {
        loaded: true,
        agents: next.agents,
        requests: next.requests,
        truncated: next.truncated,
        failed: null,
        skipped: view.skipped,
        cardTicks: view.cardTicks,
      };
    case "agent": {
      const at = view.agents.findIndex((agent) => agent.id === next.agent.id);
      if (at >= 0) return { ...view, agents: view.agents.map((agent, n) => (n === at ? next.agent : agent)) };
      return view.agents.length >= AGENT_LIMITS.perOwner
        ? skip(view)
        : { ...view, agents: [...view.agents, next.agent] };
    }
    case "agent_removed":
      return {
        ...view,
        cardTicks: Object.fromEntries(Object.entries(view.cardTicks).filter(([id]) => id !== next.id)),
        agents: view.agents.filter((agent) => agent.id !== next.id),
        requests: view.requests.filter((request) => request.agentId !== next.id),
      };
    case "request": {
      const at = view.requests.findIndex((request) => request.id === next.request.id);
      if (at >= 0)
        return { ...view, requests: view.requests.map((request, n) => (n === at ? next.request : request)) };
      return view.requests.length >= AGENTS_STREAM_LIMITS.requests
        ? { ...view, truncated: true }
        : { ...view, requests: [...view.requests, next.request] };
    }
    case "request_closed":
      return view.requests.some((request) => request.id === next.id)
        ? { ...view, requests: view.requests.filter((request) => request.id !== next.id) }
        : view;
    // A card was written or moved (M11R72): the agent tab reads its page again, the rail has nothing to change.
    case "event":
      return !view.agents.some((agent) => agent.id === next.agentId)
        ? view
        : {
            ...view,
            cardTicks: { ...view.cardTicks, [next.agentId]: (view.cardTicks[next.agentId] ?? 0) + 1 },
          };
  }
}
