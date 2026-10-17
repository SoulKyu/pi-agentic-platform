import { AUTOMATION_LIMITS, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { enqueueEffect, type Outbox } from "../../kernel/outbox/index.ts";
import type { AutomationEvents } from "./events.ts";
import { fence, newFenceId } from "./prompt.ts";
import type { TaskViews } from "./task-view.ts";
import { detailOf, type TaskStore } from "./tasks.ts";
import type { AgentBinding } from "./trigger-agent.ts";

export interface ThreadQueueDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly binding: AgentBinding;
  readonly store: Pick<TaskStore, "insert" | "get" | "ofAgent">;
  readonly outbox: Pick<Outbox, "poke">;
  readonly events: AutomationEvents;
  readonly views: TaskViews;
  readonly newId: () => string;
}

/** What `agents.queueTask` hands over (M11R77). The quote is the owner's pick from another agent's thread. */
export interface QueueInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly handOff: { readonly fromName: string; readonly quote: string } | null;
}

/**
 * A thread task the owner queued by hand (M11R77): origin `manual`, no trigger, not gated and counted like a click
 * (M10's rule). A paused agent queues it and runs it on resume; a quarantined one refuses. The quote of a hand-over is
 * fenced as `handoff`: the owner chose to hand it over, but its words are another agent's.
 */
export function createThreadQueue(deps: ThreadQueueDeps) {
  const { db, clock } = deps;
  return {
    queue(input: QueueInput): { taskId: string } {
      const { ownerId, agentId } = input;
      const ports = deps.binding.ports();
      const agent = ports?.registry.get(ownerId, agentId);
      if (!ports || !agent) throw new PapError("not_found");
      if (agent.quarantinedAt !== null) throw new PapError("agent_paused");
      if (deps.store.ofAgent(ownerId, agentId, ["queued"]).length >= AUTOMATION_LIMITS.queuedPerTrigger)
        throw new PapError("rate_limited");
      const at = clock.now();
      const taskId = deps.newId();
      const text = input.handOff
        ? `${input.prompt}\n\nContext handed over by the owner from ${input.handOff.fromName}'s thread:\n${fence(input.handOff.quote, "handoff", newFenceId())}`
        : input.prompt;
      db.transaction(() => {
        deps.store.insert({
          id: taskId,
          ownerId,
          triggerId: null,
          origin: "manual",
          cwd: ports.registry.homeOf(ownerId, agentId),
          prompt: text,
          tainted: false,
          gated: false,
          // The thread's own profile governs a thread task; this snapshot is only the row's required shape.
          policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
          title: detailOf(input.prompt) ?? "Queued task",
          detail: null,
          retryOf: null,
          retryOnInterrupt: false,
          maxRunMs: AUTOMATION_LIMITS.maxRunMinutes.fallback * 60_000,
          maxRunUsd: null,
          at,
          agentId,
          target: "thread",
        });
        enqueueEffect(db, { kind: "task.start", ownerId, payload: { taskId } }, at);
      });
      try {
        const row = deps.store.get(taskId);
        if (row) deps.events.emit({ kind: "task", ownerId, task: deps.views(row), previous: null });
      } catch (error) {
        deps.logger.warn("task_event_failed", { err: error });
      }
      deps.outbox.poke();
      return { taskId };
    },
  };
}
export type ThreadQueue = ReturnType<typeof createThreadQueue>;
