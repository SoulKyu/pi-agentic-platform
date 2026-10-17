import type { Caller, TaskView, TriggerView } from "@pap/contracts";
import type { TriggerStore } from "./store.ts";
import type { createAgentTriggerLink } from "./trigger-agent.ts";
import type { TaskViews } from "./task-view.ts";
import type { TaskStore } from "./tasks.ts";
import type { ThreadQueue } from "./thread-queue.ts";
import type { Triggers } from "./triggers.ts";

/** What the status panel lists of an agent's work (M11R76). */
const STATUS_TASKS = 10;
const STATUS_TRIGGERS = 20;

export interface AgentLinkDeps {
  /** `busy` and `cancelQueuedOf`, from the task engine (carry 1). */
  readonly taskLink: {
    busy(ownerId: string, agentId: string): boolean;
    cancelQueuedOf(ownerId: string, agentId: string): Promise<void>;
    cancelAllOf(ownerId: string, agentId: string): Promise<number>;
  };
  readonly deleteTriggersOf: (ownerId: string, agentId: string) => void;
  readonly rotateSecretsOf: ReturnType<typeof createAgentTriggerLink>["rotateSecretsOf"];
  readonly queue: ThreadQueue["queue"];
  readonly store: Pick<TaskStore, "newestOfAgent">;
  readonly views: TaskViews;
  readonly triggerStore: Pick<TriggerStore, "ofAgent">;
  readonly triggers: Pick<Triggers, "view">;
}

/** What the agents registry asks of the triggers and tasks of an agent (M11): delete, the owner's queue, the status panel. */
export function createAgentLink(deps: AgentLinkDeps) {
  return {
    ...deps.taskLink,
    deleteTriggersOf: deps.deleteTriggersOf,
    rotateSecretsOf: deps.rotateSecretsOf,
    queueTask: deps.queue,
    statusOf: (caller: Caller, agentId: string): { tasks: TaskView[]; triggers: TriggerView[] } => ({
      tasks: deps.store.newestOfAgent(caller.userId, agentId, STATUS_TASKS).map(deps.views),
      triggers: deps.triggerStore
        .ofAgent(caller.userId, agentId)
        .slice(0, STATUS_TRIGGERS)
        .map((row) => deps.triggers.view(caller, row.id)),
    }),
  };
}
