import { TASKS_LIMITS, type TaskView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Engine } from "./engine.ts";

/** What the other modules read of the tasks: who owns one, what a session's task is, and the board's rows. */
export function createTaskReads(
  deps: Pick<Engine, "store" | "views" | "gates"> & { clock: Pick<Clock, "now"> },
) {
  const { store, views, gates, clock } = deps;
  return {
    /** The task of a session and whether its trigger is over its daily budget (M10R66): the resume planner reads it. */
    taskOf(ownerId: string, sessionId: string): { taskId: string; overBudget: boolean } | null {
      const row = store.bySession(sessionId);
      // An ended task leaves its session to the owner: a later quota resume there is an ordinary one.
      if (!row || row.owner_id !== ownerId || (row.state !== "limited" && row.state !== "running"))
        return null;
      return { taskId: row.id, overBudget: gates.taskOver(ownerId, row) };
    },
    /** Who a task belongs to and which trigger it came from; null once its row is gone. */
    taskInfo(taskId: string): {
      ownerId: string;
      triggerName: string;
      sessionId: string | null;
      agentId: string | null;
      /** The trigger's `trigger_name` only; null once the trigger is deleted (the push name, M12). */
      registeredName: string | null;
    } | null {
      const row = store.get(taskId);
      return row
        ? {
            ownerId: row.owner_id,
            triggerName: row.trigger_name ?? row.title,
            sessionId: row.session_id,
            agentId: row.agent_id,
            registeredName: row.trigger_name,
          }
        : null;
    },
    /**
     * The owner's rows of the Tasks board, as it sends them: every live task and the ones that ended within its window (the
     * Overview reads the running, waiting and failed ones from them). Never another owner's.
     */
    activeTasks(ownerId: string): TaskView[] {
      return store
        .board(ownerId, clock.now() - TASKS_LIMITS.windowMs, TASKS_LIMITS.snapshotTasks)
        .map((row) => views(row));
    },
  };
}

export type TaskReads = ReturnType<typeof createTaskReads>;
