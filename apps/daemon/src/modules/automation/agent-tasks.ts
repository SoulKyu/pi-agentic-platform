import { AUTOMATION_LIMITS, AUTOMATION_READ_TOOLS, PAP_TEXT, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { enqueueEffect, type Outbox } from "../../kernel/outbox/index.ts";
import type { AutomationEvents } from "./events.ts";
import type { Gates } from "./gates.ts";
import { fence, newFenceId } from "./prompt.ts";
import { delegationLine } from "./runner-thread.ts";
import type { TaskViews } from "./task-view.ts";
import { detailOf, type NewTask, type TaskPolicySnapshot, type TaskStore } from "./tasks.ts";
import type { AgentBinding, AgentPorts } from "./trigger-agent.ts";

/** What the agents module asks of the tasks (M11R78, M11R80); the shapes are the agents module's, matched structurally. */
export interface AgentTasksDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly binding: AgentBinding;
  readonly store: Pick<
    TaskStore,
    "insert" | "get" | "runningRequester" | "delegationsSince" | "queuedDelegationsTo" | "reminders"
  >;
  readonly outbox: Pick<Outbox, "poke">;
  readonly events: AutomationEvents;
  readonly views: TaskViews;
  readonly gates: Pick<Gates, "over" | "ownerOver">;
  readonly newId: () => string;
}

/** A thread task's snapshot is only the row's required shape: the thread's own profile governs it (as for a queued task). */
const THREAD_POLICY: TaskPolicySnapshot = {
  mode: "supervised",
  tools: ["read"],
  preset: "read-only",
  env: [],
};
/** M10's read tools, supervised: all a tainted delegation may do in the target's isolated run (M11R78). */
const READ_ONLY_POLICY: TaskPolicySnapshot = {
  mode: "supervised",
  tools: [...AUTOMATION_READ_TOOLS],
  preset: "read-only",
  env: [],
};
const MAX_RUN_MS = AUTOMATION_LIMITS.maxRunMinutes.fallback * 60_000;

interface Made {
  readonly row: NewTask;
  /** Start now: a `task.start` effect with the task. A task that waits for a time has none; the due timer sends it. */
  readonly startNow: boolean;
}

/**
 * The task makers of the delegation and reminder ops (M11R78, M11R80) and the counts their caps read. Delegations and
 * reminders are gated like any automatic run of the agent (M11R74). The words that reach a model are fenced here, with a
 * fresh id each, so the ops only hand over text.
 */
export function createAgentTasks(deps: AgentTasksDeps) {
  const { db, clock } = deps;
  const delayed = new Set<() => void>();

  function ports(): AgentPorts {
    const bound = deps.binding.ports();
    if (!bound) throw new PapError("not_found");
    return bound;
  }

  /** The task and, when it starts now, its effect: one transaction, then the board is told and the outbox poked. */
  function put({ row, startNow }: Made): { taskId: string } {
    db.transaction(() => {
      deps.store.insert(row);
      if (startNow)
        enqueueEffect(db, { kind: "task.start", ownerId: row.ownerId, payload: { taskId: row.id } }, row.at);
    });
    try {
      const stored = deps.store.get(row.id);
      if (stored)
        deps.events.emit({ kind: "task", ownerId: row.ownerId, task: deps.views(stored), previous: null });
    } catch (error) {
      deps.logger.warn("task_event_failed", { err: error });
    }
    deps.outbox.poke();
    if (row.notBefore != null) for (const listener of delayed) listener();
    return { taskId: row.id };
  }

  return {
    runningRequester: deps.store.runningRequester,
    delegationsSince: deps.store.delegationsSince,
    queuedDelegationsTo: deps.store.queuedDelegationsTo,
    reminders: deps.store.reminders,
    overBudget: (ownerId: string, agentId: string): boolean => deps.gates.over(ownerId, null, agentId),
    /** The owner's own daily line (M10R66) alone: for a session that has no agent (a project's box). */
    ownerOverBudget: (ownerId: string): boolean => deps.gates.ownerOver(ownerId),

    /**
     * A delegation (M11R78). Untainted: a thread task for the target, its prompt the fenced words (the fixed first line is
     * added when it starts, `promptHeadOf`). Tainted: an isolated, tainted task with M10's read tools, supervised, whose
     * prompt carries its own first line (it has no thread to say it) and where its files go (owner m18, M11R14).
     */
    delegate(request: {
      readonly ownerId: string;
      readonly requesterId: string;
      readonly targetId: string;
      readonly text: string;
      readonly isolated: boolean;
    }): { taskId: string } {
      const { registry } = ports();
      const requester = registry.get(request.ownerId, request.requesterId);
      if (!requester || !registry.get(request.ownerId, request.targetId)) throw new PapError("not_found");
      const id = deps.newId();
      const words = fence(request.text, "delegation", newFenceId());
      const scratch = request.isolated ? registry.scratchPathOf(request.ownerId, request.targetId, id) : null;
      return put({
        startNow: true,
        row: {
          id,
          ownerId: request.ownerId,
          triggerId: null,
          origin: "delegate",
          cwd: registry.homeOf(request.ownerId, request.targetId),
          prompt:
            scratch === null
              ? words
              : `${delegationLine(requester.name, `in your working folder ${scratch}`)}\n\n${words}`,
          tainted: request.isolated,
          gated: true,
          policy: request.isolated ? READ_ONLY_POLICY : THREAD_POLICY,
          title: `Delegation from ${requester.name}`,
          detail: detailOf(request.text),
          retryOf: null,
          retryOnInterrupt: false,
          maxRunMs: MAX_RUN_MS,
          maxRunUsd: null,
          at: clock.now(),
          agentId: request.targetId,
          target: request.isolated ? "isolated" : "thread",
          requestedBy: request.requesterId,
        },
      });
    },

    /** A reminder (M11R80): a thread task for the agent itself, not started before `notBefore`. */
    remind(request: {
      readonly ownerId: string;
      readonly agentId: string;
      readonly note: string;
      readonly notBefore: number;
      readonly requestedBy: string | null;
      readonly tainted: boolean;
      readonly sessionId: string;
    }): { taskId: string } {
      const { registry } = ports();
      if (!registry.get(request.ownerId, request.agentId)) throw new PapError("not_found");
      return put({
        startNow: false,
        row: {
          id: deps.newId(),
          ownerId: request.ownerId,
          triggerId: null,
          origin: "remind",
          cwd: registry.homeOf(request.ownerId, request.agentId),
          prompt: fence(request.note, "reminder", newFenceId()),
          tainted: request.tainted,
          gated: true,
          policy: THREAD_POLICY,
          // A title pap wrote: the board never shows the model's words; the note is in the prompt and the card.
          title: PAP_TEXT.reminderTitle,
          detail: null,
          retryOf: null,
          retryOnInterrupt: false,
          maxRunMs: MAX_RUN_MS,
          maxRunUsd: null,
          at: clock.now(),
          agentId: request.agentId,
          target: "thread",
          requestedBy: request.requestedBy,
          notBefore: request.notBefore,
          setBySession: request.sessionId,
        },
      });
    },

    /** Told after a task that waits for a time was made: the scheduler arms its timer for it (M11R81). */
    onDelayed(listener: () => void): () => void {
      delayed.add(listener);
      return () => void delayed.delete(listener);
    },
  };
}
