import {
  type AutomationSettings,
  inQuietHours,
  PapError,
  TASKS_LIMITS,
  type TasksCounts,
  type TasksStreamEvent,
  type TaskTrigger,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { RunsPort } from "../runs/index.ts";
import type { AutomationEvents } from "./events.ts";
import type { TaskViews } from "./task-view.ts";
import type { TaskStore } from "./tasks.ts";
import type { TriggerChanged } from "./triggers.ts";

export interface TasksStreamDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: TaskStore;
  readonly views: TaskViews;
  readonly events: AutomationEvents;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  readonly outbox: Pick<Outbox, "failures" | "dismiss" | "onFailed">;
  readonly triggers: {
    summaries(ownerId: string): TaskTrigger[];
    summary(ownerId: string, id: string): TaskTrigger | null;
  };
  readonly runs: Pick<RunsPort, "spentToday">;
  readonly settings: { automation(ownerId: string): AutomationSettings };
}

type Snapshot = Extract<TasksStreamEvent, { kind: "snapshot" }>;

/**
 * The `tasks` stream (M10R43), keyed by owner like `shell`: one snapshot when the board opens, then an event per change.
 * Nothing is sent to an owner who is not the task's, the trigger's or the failure's.
 */
export function createTasksStream(deps: TasksStreamDeps) {
  const { clock, store } = deps;

  function counts(ownerId: string): TasksCounts {
    const settings = deps.settings.automation(ownerId);
    return {
      paused: settings.paused,
      slots: settings.slots,
      ...store.counts(ownerId),
      quietHours: inQuietHours(settings.quietHours, settings.timezone, clock.now()),
      todayUsd: deps.runs.spentToday(ownerId, settings.timezone),
      budgetUsd: settings.dailyBudgetUsd,
    };
  }

  function snapshot(ownerId: string): Snapshot {
    const rows = deps.store.board(
      ownerId,
      clock.now() - TASKS_LIMITS.windowMs,
      TASKS_LIMITS.snapshotTasks + 1,
    );
    const head = {
      kind: "snapshot" as const,
      ...counts(ownerId),
      tasks: [],
      truncated: rows.length > TASKS_LIMITS.snapshotTasks,
      triggers: deps.triggers.summaries(ownerId).slice(0, TASKS_LIMITS.triggers),
      failures: deps.outbox.failures(ownerId),
    };
    // Under the frame budget (M2R54): a long history is cut here, with `truncated`, never by the transport.
    let used = sizeOf(head);
    const tasks: Snapshot["tasks"] = [];
    for (const row of rows.slice(0, TASKS_LIMITS.snapshotTasks)) {
      const view = deps.views(row);
      const size = sizeOf(view) + 1;
      if (used + size > PAGE_BYTES) {
        head.truncated = true;
        break;
      }
      used += size;
      tasks.push(view);
    }
    return { ...head, tasks };
  }

  function publish(ownerId: string, event: TasksStreamEvent): void {
    try {
      deps.hub.publish("tasks", ownerId, event);
    } catch (error) {
      deps.logger.warn("tasks_publish_failed", { kind: event.kind, err: error });
    }
  }

  deps.hub.registerSnapshot("tasks", (ownerId) => snapshot(ownerId));
  const stops = [
    deps.events.on((event) => {
      if (event.kind !== "task") return;
      publish(event.ownerId, { kind: "task", task: event.task, previous: event.previous });
      publish(event.ownerId, { kind: "counts", counts: counts(event.ownerId) });
    }),
    // A system effect (no owner) is in every snapshot; there is no owner to push it to.
    deps.outbox.onFailed((failure) => {
      if (failure.ownerId === null) return;
      const { ownerId, ...rest } = failure;
      publish(ownerId, { kind: "failure", failure: rest });
    }),
  ];

  return {
    snapshot,
    counts,
    /** Dismisses one failed effect of this owner or the system's; anything else is `not_found` (M10R45). */
    dismiss(ownerId: string, effectId: number): void {
      if (!deps.outbox.dismiss(ownerId, effectId)) throw new PapError("not_found");
      publish(ownerId, { kind: "failure_dismissed", id: effectId });
    },
    /** The trigger list changed: a saved, switched, rotated or deleted trigger. */
    triggerChanged(change: TriggerChanged): void {
      if (change.removed) return publish(change.ownerId, { kind: "trigger_removed", id: change.triggerId });
      const trigger = deps.triggers.summary(change.ownerId, change.triggerId);
      if (trigger) publish(change.ownerId, { kind: "trigger", trigger });
    },
    stop(): void {
      for (const stopListening of stops.splice(0)) stopListening();
    },
  };
}
export type TasksStream = ReturnType<typeof createTasksStream>;
