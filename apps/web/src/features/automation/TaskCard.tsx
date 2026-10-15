import type { TaskView } from "@pap/contracts";
import { Button, Chip, cn, Fence, RunStatusChip } from "@pap/ui";
import { useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { useT } from "../../i18n/index.ts";
import { actionsFor, cardStatus, shown, taskCost, taskDuration, type TaskAction } from "./board.vm.ts";
import { TaskDialogs, type TaskDialogKind } from "./TaskDialogs.tsx";
import { useTaskActions } from "./use-task-actions.ts";

export interface TaskCardProps {
  readonly task: TaskView;
  readonly now: number;
  /** The card whose session was opened last: it wears the agent rule and `aria-current`. */
  readonly current: boolean;
  onOpenSession(sessionId: string, taskId: string): void;
}

/** One task (board 11 §2): its chip, the trigger name, the fenced detail, the meta line and the buttons its state allows. */
export function TaskCard({ task, now, current, onOpenSession }: TaskCardProps) {
  const t = useT();
  const actions = useTaskActions(task);
  const [asking, setAsking] = useState<TaskDialogKind | null>(null);
  const status = cardStatus(task);
  const duration = taskDuration(task, now);
  const meta = [shown(task.origin, "name"), formatAge(now, task.createdAt, t), duration, taskCost(task)];
  const idle = actions.since === null;

  const run = (action: TaskAction) => {
    if (action === "cancel") {
      if (task.state === "queued" || task.state === "limited") actions.cancel();
      else setAsking("stop");
    } else if (action === "releaseTools") setAsking("tools");
    else if (action === "retry") actions.retry();
    else if (action === "resumeNow") actions.resumeNow();
    else if (task.sessionId !== null) onOpenSession(task.sessionId, task.id);
  };

  return (
    <li
      data-slot="task-card"
      data-state={task.state}
      aria-current={current ? "true" : undefined}
      className={cn(
        "flex flex-col gap-s2 border-b border-l-2 border-b-border px-s3 py-s2 last:border-b-0",
        current ? "border-l-agent bg-surface-2" : "border-l-transparent",
      )}
    >
      <div className="flex items-start gap-s2">
        {status.status === null ? (
          <Chip tone={status.tone} label={t(status.label)} />
        ) : (
          <RunStatusChip status={status.status} label={t(status.label)} />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-s1">
          <p className="break-words text-ui text-fg">{shown(task.triggerName || task.title, "name")}</p>
          <p className="font-mono text-label text-muted tabular-nums">
            {meta.filter((part) => part !== null).join(" · ")}
          </p>
        </div>
        {task.toolsReleased ? <Chip tone="mut" label={t("automation.card.toolsReleased")} /> : null}
      </div>
      {task.detail ? (
        <Fence label={t("automation.card.fence", { source: shown(task.origin, "name") })}>
          {shown(task.detail, "detail")}
        </Fence>
      ) : null}
      <div className="flex flex-wrap items-center gap-s2">
        {actionsFor(task).map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === "reply" ? "primary" : "secondary"}
            disabled={!idle && actions.active !== action}
            pendingSince={actions.active === action ? actions.since : null}
            onClick={() => run(action)}
          >
            {t(
              action === "cancel" && task.state === "limited"
                ? "automation.action.cancelTask"
                : `automation.action.${action}`,
            )}
          </Button>
        ))}
      </div>
      {actions.error ? (
        <p role="alert" className="text-ui text-err">
          {actions.error}
        </p>
      ) : null}
      <TaskDialogs
        kind={asking}
        onClose={() => setAsking(null)}
        onConfirm={(kind) => {
          setAsking(null);
          if (kind === "stop") actions.cancel();
          else actions.releaseTools();
        }}
      />
    </li>
  );
}
