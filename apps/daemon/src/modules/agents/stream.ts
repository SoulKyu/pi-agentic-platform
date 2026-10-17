import {
  AGENT_LIMITS,
  AGENTS_STREAM_LIMITS,
  type AgentRailState,
  type AgentRequestView,
  type AgentsStreamEvent,
  type AgentSummary,
  agentInitials,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAgentPort } from "../sessions/index.ts";
import type { AgentLinks } from "./links.ts";
import { type RailFacts, railStateOf } from "./rail-state.ts";
import type { RequestViews } from "./requests-store.ts";
import type { AgentRecord, AgentStore } from "./store.ts";

/** At most one batch of rail events per owner in this window (M11R62). */
export const RAIL_EVERY_MS = 250;

export interface AgentsStreamDeps {
  readonly store: Pick<AgentStore, "get" | "list" | "byThread">;
  readonly requests: Pick<RequestViews, "pending" | "waiting" | "find">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  readonly sessions: Pick<SessionsAgentPort, "threadState">;
  /** `updated_at` of a session row: the thread's last change. */
  lastActivityAt(sessionId: string): number | null;
  readonly runs: Pick<RunsPort, "onRunStart" | "onRunEnd">;
  /** A session's open dialog appeared or went (the sessions module's attention feed). */
  onAttention(listener: (sessionId: string) => void): () => void;
  /** Read at each use: the links are bound after the module is built. */
  readonly links: () => AgentLinks;
}

type Snapshot = Extract<AgentsStreamEvent, { kind: "snapshot" }>;

/**
 * The `agents` stream (M11R63): per owner, keyless like `inbox`. A change marks the agent dirty; the owner's batch goes
 * out one window after the first mark, one `agent` event per agent whose summary really differs from the last sent.
 */
export function createAgentsStream(deps: AgentsStreamDeps) {
  const { clock, logger, store } = deps;
  /** The last summary sent per agent, as JSON: a change that leaves it as it was publishes nothing. */
  const sent = new Map<string, string>();
  const batches = new Map<string, { readonly timer: TimerHandle; readonly dirty: Set<string> }>();

  /** A fact read through a link that throws counts as "no": the rail never fails a snapshot (logged, bounded by the cap). */
  function fact(name: string, read: () => boolean | undefined): boolean {
    try {
      return read() === true;
    } catch (error) {
      logger.warn("agents_rail_fact_failed", { fact: name, err: error });
      return false;
    }
  }

  function factsOf(record: AgentRecord, waiting: ReadonlySet<string>): RailFacts {
    const { rail, automation } = deps.links();
    const thread =
      record.threadSessionId === null
        ? null
        : deps.sessions.threadState(record.ownerId, record.threadSessionId);
    return {
      unreadable: record.input === null,
      quarantined: record.quarantinedAt !== null,
      paused: record.paused,
      threadNeedsInput: thread?.needsInput === true,
      requestPending: waiting.has(record.id),
      childWaiting: fact("child_waiting", () => rail?.childWaiting(record.ownerId, record.id)),
      threadRunning: thread?.running === true || thread?.starting === true,
      taskRunning: fact("task_running", () => automation?.busy(record.ownerId, record.id)),
      failedCard: fact("failed_card", () => rail?.failedCard(record.ownerId, record.id)),
    };
  }

  function summaryOf(record: AgentRecord, waiting: ReadonlySet<string>): AgentSummary {
    const thread = record.threadSessionId === null ? null : deps.lastActivityAt(record.threadSessionId);
    return {
      id: record.id,
      name: record.name,
      initials: agentInitials(record.name, record.input?.initials),
      state: railStateOf(factsOf(record, waiting)),
      unread: record.unread,
      paused: record.paused,
      quarantined: record.quarantinedAt !== null,
      unreadable: record.input === null,
      threadSessionId: record.threadSessionId,
      lastActivityAt: Math.max(record.updatedAt, thread ?? 0),
    };
  }

  function publish(ownerId: string, event: AgentsStreamEvent): void {
    try {
      deps.hub.publish("agents", ownerId, event);
    } catch (error) {
      logger.warn("agents_publish_failed", { kind: event.kind, err: error });
    }
  }

  function snapshot(ownerId: string): Snapshot {
    const waiting = deps.requests.waiting(ownerId);
    const agents = store
      .list(ownerId)
      .slice(0, AGENT_LIMITS.perOwner)
      .map((record) => summaryOf(record, waiting));
    // `sent` is what went out, not what a client holds: the client now holds this snapshot, so the next change is told in full.
    for (const agent of agents) sent.delete(agent.id);
    const rows = deps.requests.pending(ownerId, AGENTS_STREAM_LIMITS.requests + 1);
    const head = {
      kind: "snapshot" as const,
      agents,
      requests: [],
      truncated: rows.length > AGENTS_STREAM_LIMITS.requests,
    };
    // Under the frame budget (M2R54): the oldest requests first, with `truncated` when the rest is left out.
    let used = sizeOf(head);
    const requests: AgentRequestView[] = [];
    for (const request of rows.slice(0, AGENTS_STREAM_LIMITS.requests)) {
      const size = sizeOf(request) + 1;
      if (used + size > PAGE_BYTES) return { ...head, requests, truncated: true };
      used += size;
      requests.push(request);
    }
    return { ...head, requests };
  }

  function flush(ownerId: string): void {
    const batch = batches.get(ownerId);
    batches.delete(ownerId);
    if (!batch) return;
    const waiting = deps.requests.waiting(ownerId);
    for (const agentId of batch.dirty) {
      const record = store.get(ownerId, agentId);
      if (!record) continue;
      const agent = summaryOf(record, waiting);
      const text = JSON.stringify(agent);
      if (sent.get(agentId) === text) continue;
      sent.set(agentId, text);
      publish(ownerId, { kind: "agent", agent });
    }
  }

  /** The agent's entry may have changed: it goes out with the owner's next batch. */
  function touch(ownerId: string, agentId: string): void {
    const batch = batches.get(ownerId);
    if (batch) return void batch.dirty.add(agentId);
    const timer = clock.setTimeout(
      () => void guardTimer(logger, "agents_rail", () => flush(ownerId), clock),
      RAIL_EVERY_MS,
    );
    batches.set(ownerId, { timer, dirty: new Set([agentId]) });
  }

  const threadChanged = (sessionId: string): void => {
    const record = store.byThread(sessionId);
    if (record) touch(record.ownerId, record.id);
  };

  deps.hub.registerSnapshot("agents", (ownerId) => snapshot(ownerId));
  const stops = [
    deps.runs.onRunStart((event) => threadChanged(event.sessionId)),
    deps.runs.onRunEnd((event) => threadChanged(event.sessionId)),
    deps.onAttention(threadChanged),
  ];

  return {
    snapshot,
    touch,
    /** The rail state now (not throttled); null for an agent that is not the owner's. */
    state(ownerId: string, agentId: string): AgentRailState | null {
      const record = store.get(ownerId, agentId);
      return record ? summaryOf(record, deps.requests.waiting(ownerId)).state : null;
    },
    /** Every agent of the owner is read again; the ones that differ go out (Task 10's tasks, Task 30's children). */
    publish(ownerId: string): void {
      for (const record of store.list(ownerId)) touch(ownerId, record.id);
    },
    /** A card was written or moved: the hint goes out at once, the open agent tab reads the page again (M11R72). */
    eventWritten(ownerId: string, agentId: string, eventId: number): void {
      publish(ownerId, { kind: "event", agentId, eventId });
    },
    /** A create, an edit, a switch or a delete of the registry. A delete goes out at once. */
    registryChanged(change: { ownerId: string; agentId: string; removed: boolean }): void {
      if (!change.removed) return touch(change.ownerId, change.agentId);
      sent.delete(change.agentId);
      batches.get(change.ownerId)?.dirty.delete(change.agentId);
      publish(change.ownerId, { kind: "agent_removed", id: change.agentId });
    },
    /** A request opened or closed: told from the row, so a late call cannot show a closed request as open (Task 17). */
    requestChanged(ownerId: string, requestId: string): void {
      const found = deps.requests.find(ownerId, requestId);
      if (found?.pending === true) publish(ownerId, { kind: "request", request: found.request });
      else publish(ownerId, { kind: "request_closed", id: requestId });
      if (found) touch(ownerId, found.request.agentId);
    },
    stop(): void {
      for (const stopListening of stops.splice(0)) stopListening();
      for (const batch of batches.values()) clock.clearTimeout(batch.timer);
      batches.clear();
    },
  };
}
