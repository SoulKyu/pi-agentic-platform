import type { BoxRef, TaskView } from "@pap/contracts";
import { Button, Chip, cn, Fence, InlineError, RunStatusChip } from "@pap/ui";
import { useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { useT } from "../../i18n/index.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { papText } from "../../i18n/pap-text.ts";
import { requestedByName } from "./agent-columns.vm.ts";
import {
  actionsFor,
  cardStatus,
  reasonWords,
  shown,
  taskCost,
  taskDuration,
  type TaskAction,
} from "./board.vm.ts";
import { LaunchStrip } from "../launch/LaunchStrip.tsx";
import { WaitingLine } from "../launch/WaitingLine.tsx";
import { TaskDialogs, type TaskDialogKind } from "./TaskDialogs.tsx";
import { useTaskActions } from "./use-task-actions.ts";

/** The box a task runs in: its agent's, else its project's (a host project has no launch to show). */
const boxOfTask = (task: TaskView): BoxRef | null =>
  task.agentId
    ? { kind: "agent", id: task.agentId }
    : task.projectId
      ? { kind: "project", id: task.projectId }
      : null;

export interface TaskCardProps {
  readonly task: TaskView;
  readonly now: number;
  /** The card whose session was opened last: it wears the agent rule and `aria-current`. */
  readonly current: boolean;
  onOpenSession(sessionId: string, taskId: string): void;
  /** "requested by <name>" opens that agent (M11R128). */
  onOpenAgent?(agentId: string): void;
}

/** One task (board 11 §2): its chip, the trigger name, the fenced detail, the meta line and the buttons its state allows. */
export function TaskCard({ task, now, current, onOpenSession, onOpenAgent }: TaskCardProps) {
  const t = useT();
  const requestedBy = task.requestedBy ?? null;
  const requester = requestedByName(
    task,
    useAgents((view) => view.agents),
  );
  const actions = useTaskActions(task);
  const [asking, setAsking] = useState<TaskDialogKind | null>(null);
  const status = cardStatus(task);
  const reason = reasonWords(task);
  const label = reason === null ? t(status.label) : `${t(status.label)} · ${reason}`;
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
          <Chip tone={status.tone} label={label} />
        ) : (
          <RunStatusChip status={status.status} label={label} />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-s1">
          <p className="break-words text-ui text-fg">
            {shown(papText(t, task.triggerName || task.title), "name")}
          </p>
          <p className="font-mono text-label text-muted tabular-nums">
            {meta.filter((part) => part !== null).join(" · ")}
          </p>
          {task.waiting ? <WaitingLine waiting={task.waiting} now={now} /> : null}
          <LaunchStrip
            box={boxOfTask(task)}
            only={(launch) => launch.for === task.id || task.state === "queued"}
          />
          {task.target ? <Chip tone="mut" label={t(`automation.card.target.${task.target}`)} /> : null}
          {requester !== null && requestedBy ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenAgent?.(requestedBy)}>
              {t("automation.card.requestedBy", { name: shown(requester, "name") })}
            </Button>
          ) : null}
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
      {actions.error ? <InlineError announce="action">{actions.error}</InlineError> : null}
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
