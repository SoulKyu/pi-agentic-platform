import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RunsPort } from "../runs/index.ts";
import type { AgentStore } from "./store.ts";

const COUNTED_RUNS = 256;

export interface UnreadDeps {
  readonly store: Pick<AgentStore, "byThread" | "bumpUnread" | "markRead">;
  readonly clock: Pick<Clock, "now">;
  readonly runs: Pick<RunsPort, "onRunEnd">;
  /** The agent's rail entry changed. */
  changed(ownerId: string, agentId: string): void;
  /** The agent's `agent_reply` Inbox item (M11R91): raised when the count rises, closed when the owner reads the thread. */
  readonly reply?: {
    raise(ownerId: string, agentId: string): void;
    clear(ownerId: string, agentId: string): void;
  };
  readonly logger?: Pick<Logger, "warn">;
}

/**
 * The rail badge (M11R61): +1 when a run of the agent's thread ends `completed`, +1 per event card (Task 11), 0 when
 * the owner reads the thread. A counter, capped by the column, never a list.
 */
export function createUnread(deps: UnreadDeps) {
  function bump(ownerId: string, agentId: string): void {
    if (!deps.store.bumpUnread(ownerId, agentId)) return;
    deps.changed(ownerId, agentId);
    inbox(() => deps.reply?.raise(ownerId, agentId));
  }
  /** The Inbox is a mirror of the count: a failed write is logged and never fails the run's end or the read. */
  function inbox(write: () => void): void {
    try {
      write();
    } catch (error) {
      deps.logger?.warn("agent_reply_item_failed", { err: error });
    }
  }
  /** The newest run ends counted: a run end fed twice adds once. Bounded, the oldest forgotten first. */
  const counted = new Set<string>();
  const stop = deps.runs.onRunEnd((event) => {
    if (event.status !== "completed" || counted.has(event.runId)) return;
    counted.add(event.runId);
    if (counted.size > COUNTED_RUNS) counted.delete(counted.values().next().value as string);
    const agent = deps.store.byThread(event.sessionId);
    if (agent && agent.ownerId === event.ownerId) bump(agent.ownerId, agent.id);
  });
  return {
    bump,
    /** The owner read the thread; `not_found` for an agent that is not the owner's. */
    markRead(ownerId: string, agentId: string): void {
      if (!deps.store.markRead(ownerId, agentId, deps.clock.now())) throw new PapError("not_found");
      deps.changed(ownerId, agentId);
      inbox(() => deps.reply?.clear(ownerId, agentId));
    },
    stop,
  };
}
export type Unread = ReturnType<typeof createUnread>;
