import { AGENT_EVENT_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { type PlatformContext, type PlatformHandler, PlatformRefusal } from "../platform/index.ts";
import type { AgentEvents } from "./events.ts";
import type { RequestItems } from "./requests.ts";
import type { AgentsPort } from "./service.ts";
import { type AgentTasksPort, type DelegationRequest, refusalOf } from "./task-port.ts";

/** Delegations one agent may ask for in a rolling hour (M11R78). */
export const DELEGATIONS_PER_HOUR = 10;
/** Delegations that may wait for one target at a time, from every requester (T12): a full queue answers `limit_reached`. */
export const DELEGATIONS_QUEUED_PER_TARGET = 20;
const HOUR_MS = 3_600_000;

export interface DelegateDeps {
  readonly clock: Pick<Clock, "now">;
  readonly agents: Pick<AgentsPort, "get" | "byName">;
  readonly tasks: Pick<
    AgentTasksPort,
    "runningRequester" | "delegationsSince" | "queuedDelegationsTo" | "overBudget" | "delegate"
  >;
}

/**
 * The taint branch of `agent.delegate` (owner m18, M11R82), in one place. An untainted caller hands a thread task to the
 * target; a tainted one (its Allow once was checked by the dispatcher) hands an isolated, tainted task, so its words never
 * enter the target's trusted thread. Autonomy (X2a) composes here.
 */
function delegationByTaint(
  ctx: PlatformContext,
  requesterId: string,
  targetId: string,
  text: string,
): DelegationRequest {
  return { ownerId: ctx.ownerId, requesterId, targetId, text, isolated: ctx.tainted };
}

/**
 * `agent.delegate` (M11R78). The refusals come in the ruled order, each one before the next lookup is made, and the check
 * and the task are one step with no await: the counts that were read are the ones the task is added to.
 */
export function createDelegate(deps: DelegateDeps): PlatformHandler<"agent.delegate"> {
  return (args, ctx) => {
    try {
      const callerId = ctx.agentId;
      const caller = callerId === null ? null : deps.agents.get(ctx.ownerId, callerId);
      if (callerId === null || caller === null) throw new PlatformRefusal("not_found");
      if (args.agent.toLowerCase() === caller.name.toLowerCase()) throw new PlatformRefusal("refused");
      const target = deps.agents.byName(ctx.ownerId, args.agent);
      if (target === null) throw new PlatformRefusal("not_found");
      if (target.input?.acceptsDelegation !== true) throw new PlatformRefusal("refused");
      // A tainted request runs isolated with read tools: wider than a target whose own thread has none (W5-R26 principle).
      if (ctx.tainted && (target.input.preset === "chat" || target.input.preset === "none"))
        throw new PlatformRefusal("refused");
      // Depth 1: a run that was itself delegated delegates no further (a reminder it set keeps the mark, RT-16).
      if (deps.tasks.runningRequester(ctx.ownerId, callerId) !== null) throw new PlatformRefusal("refused");
      if (target.paused || target.quarantinedAt !== null) throw new PlatformRefusal("paused");
      if (
        deps.tasks.delegationsSince(ctx.ownerId, callerId, deps.clock.now() - HOUR_MS) >= DELEGATIONS_PER_HOUR
      )
        throw new PlatformRefusal("rate_limited");
      if (deps.tasks.queuedDelegationsTo(ctx.ownerId, target.id) >= DELEGATIONS_QUEUED_PER_TARGET)
        throw new PlatformRefusal("limit_reached");
      if (deps.tasks.overBudget(ctx.ownerId, target.id)) throw new PlatformRefusal("budget");
      const made = deps.tasks.delegate(delegationByTaint(ctx, callerId, target.id, args.task));
      return Promise.resolve({ taskId: made.taskId });
    } catch (error) {
      return Promise.reject(refusalOf(error));
    }
  };
}

/** How a delegated task ended, as the runner's end hook hears it (M11R79). */
export interface DelegationEnd {
  readonly ownerId: string;
  readonly taskId: string;
  readonly requesterId: string;
  readonly targetId: string;
  /** `interrupted`: the daemon stopped while the target worked on it (the boot); the requester still hears of it. */
  readonly state: "done" | "failed" | "interrupted";
  /** The target run's last assistant text; one unit past the card's limit tells the card it was clipped. */
  readonly summary: string | null;
  readonly tainted: boolean;
  readonly isolated: boolean;
}

/** How much of a summary the card is asked for: one unit more than it shows, so a clip is seen. */
export const DELEGATION_ASK_CHARS = AGENT_EVENT_LIMITS.delegationChars + 1;
const DETAIL_CHARS = 200;

export interface DelegationBackDeps {
  readonly agents: Pick<AgentsPort, "get">;
  readonly events: Pick<AgentEvents, "delegation">;
  /** The Inbox's port for agent items (M11R91). */
  readonly inbox: Pick<RequestItems, "upsertAgentItem">;
  readonly logger: Pick<Logger, "warn">;
}

/**
 * M11R79: the result of a delegated task goes back to the requester as a card in its thread (unread +1) and an Inbox
 * reply item for the owner. It is never a prompt: nothing here reaches a model. A requester that is gone has nobody to tell.
 */
export function createDelegationBack(deps: DelegationBackDeps) {
  return {
    back(end: DelegationEnd): void {
      if (deps.agents.get(end.ownerId, end.requesterId) === null) return;
      const from = deps.agents.get(end.ownerId, end.targetId)?.name ?? "?";
      const written = deps.events.delegation(end.ownerId, end.requesterId, end.taskId, {
        fromAgentId: end.targetId,
        fromName: from,
        state: end.state,
        summary: end.summary,
        tainted: end.tainted,
        isolated: end.isolated,
      });
      if (!written) return;
      const line = (end.summary ?? "").split(/\r?\n/).find((text) => text.trim() !== "") ?? "";
      const label = end.state === "done" ? from : `${from} (${end.state})`;
      try {
        deps.inbox.upsertAgentItem({
          ownerId: end.ownerId,
          kind: "delegation_done",
          agentId: end.requesterId,
          refId: end.taskId,
          toHandle: false,
          detail: line === "" ? label : `${label}: ${line.trim().slice(0, DETAIL_CHARS)}`,
        });
      } catch (error) {
        deps.logger.warn("delegation_inbox_failed", { err: error });
      }
    },
  };
}
export type DelegationBack = ReturnType<typeof createDelegationBack>;
