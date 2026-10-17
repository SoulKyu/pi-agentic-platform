import type { AgentRailState } from "@pap/contracts";

/** What the rail state is read from (M11R62). Each fact is one yes or no taken at the moment of the read. */
export interface RailFacts {
  /** The stored profile does not parse: the agent cannot start, so it reads like a paused one. */
  readonly unreadable: boolean;
  readonly quarantined: boolean;
  readonly paused: boolean;
  /** The thread has an open dialog. */
  readonly threadNeedsInput: boolean;
  /** The agent has a pending request (`agent.approve`, `secret.request`). */
  readonly requestPending: boolean;
  /** A child of the thread waits for the owner: its approval or input dialog is open (Task 30). */
  readonly childWaiting: boolean;
  readonly threadRunning: boolean;
  /** One of the agent's tasks runs or starts. */
  readonly taskRunning: boolean;
  /** The newest unread event card says failed (Task 11). */
  readonly failedCard: boolean;
}

/** Highest first; `quarantined` is shown instead of all of them. A waiting agent never looks idle. */
export function railStateOf(facts: RailFacts): AgentRailState {
  if (facts.quarantined) return "quarantined";
  if (facts.threadNeedsInput || facts.requestPending || facts.childWaiting) return "needs_input";
  if (facts.threadRunning || facts.taskRunning) return "running";
  if (facts.failedCard) return "failed";
  if (facts.paused || facts.unreadable) return "paused";
  return "idle";
}
