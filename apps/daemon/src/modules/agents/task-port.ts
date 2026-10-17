import { PapError } from "@pap/contracts";
import { PlatformRefusal } from "../platform/index.ts";

/** A delegation for the task makers (M11R78): the text is the requester's words, fenced by the maker. */
export interface DelegationRequest {
  readonly ownerId: string;
  readonly requesterId: string;
  readonly targetId: string;
  readonly text: string;
  /** The requester was tainted: the task runs isolated and tainted, never in the target's trusted thread (owner m18). */
  readonly isolated: boolean;
}

/** A reminder for the task makers (M11R80): the note is the agent's words, fenced by the maker. */
export interface ReminderRequest {
  readonly ownerId: string;
  readonly agentId: string;
  readonly note: string;
  /** When it may start, already inside the bounds and moved out of quiet hours. */
  readonly notBefore: number;
  /** The requester of the run that sets it (RT-16): a reminder set inside a delegated run stays delegated. */
  readonly requestedBy: string | null;
  readonly tainted: boolean;
  /** The session that sets it: a tainted reminder fires only into this very session (W5-R44). */
  readonly sessionId: string;
}

/**
 * What the two ops ask of the automation module: counts for the caps, the budget line, and the two task makers. The
 * automation module implements it; this module never imports it (a module imports only another's `index.ts`).
 */
export interface AgentTasksPort {
  /** The agent's running thread task was delegated: its requester (depth, M11R78; inherited by a reminder, RT-16). */
  runningRequester(ownerId: string, agentId: string): string | null;
  /** The delegations the agent asked for since `since` (the rolling hour of M11R78). */
  delegationsSince(ownerId: string, requesterId: string, since: number): number;
  /** The delegations waiting to start for `agentId`, from any requester (T12's per-target cap). */
  queuedDelegationsTo(ownerId: string, agentId: string): number;
  /** The agent's reminders: not yet started, and made since `since` (M11R80). */
  reminders(
    ownerId: string,
    agentId: string,
    since: number,
  ): { readonly pending: number; readonly created: number };
  /** The owner's line, or the agent's own, is reached (M11R74): a gated task for it would be refused. */
  overBudget(ownerId: string, agentId: string): boolean;
  delegate(request: DelegationRequest): { readonly taskId: string };
  remind(request: ReminderRequest): { readonly taskId: string };
}

/** What a throw from a task maker becomes for the worker: an agent gone is `not_found`, anything else stays an error (`internal`). */
export function refusalOf(error: unknown): Error {
  if (error instanceof PapError && error.code === "not_found") return new PlatformRefusal("not_found");
  return error instanceof Error ? error : new Error("platform_op_failed");
}
