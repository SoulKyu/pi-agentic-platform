import { formatCost } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { costToday, countRunning, shown, type BoardColumn } from "./board.vm.ts";
import { TaskCard } from "./TaskCard.tsx";
import { TriggerStrip } from "./TriggerStrip.tsx";

interface ProjectColumnProps {
  readonly column: BoardColumn;
  readonly now: number;
  readonly currentTaskId: string | null;
  onOpenSession(sessionId: string, taskId: string): void;
  onOpenTrigger(triggerId: string): void;
  onNewTrigger(projectId: string): void;
}

/** One project (board 11 §2, one column per project; agents have their own columns): header, its triggers strip, then its tasks. */
export function ProjectColumn({
  column,
  now,
  currentTaskId,
  onOpenSession,
  onOpenTrigger,
  onNewTrigger,
}: ProjectColumnProps) {
  const t = useT();
  const name = column.name === null ? t("automation.column.other") : shown(column.name, "name");
  const hasStrip = column.triggers.length > 0 || column.projectId !== null;
  return (
    <section
      data-slot="project-column"
      data-column={column.key}
      aria-label={name}
      className="flex min-w-0 flex-col rounded-md border border-border-strong bg-surface"
    >
      <header className="flex flex-wrap items-center gap-s2 border-b border-border px-s3 py-s2">
        <h2 className="min-w-0 flex-1 break-words text-ui font-semibold text-fg">{name}</h2>
        <span className="font-mono text-label text-muted tabular-nums">
          {t("automation.column.running", { count: countRunning(column.tasks) })}
        </span>
        <span className="font-mono text-label text-muted tabular-nums">
          {t("automation.column.cost", { cost: formatCost(costToday(column.tasks, now)) })}
        </span>
      </header>
      {hasStrip ? (
        <TriggerStrip
          triggers={column.triggers}
          projectId={column.projectId}
          projectName={name}
          onOpenTrigger={onOpenTrigger}
          onNewTrigger={onNewTrigger}
        />
      ) : null}
      {column.tasks.length === 0 ? (
        <p className="px-s3 py-s3 text-ui text-muted">{t("automation.column.empty")}</p>
      ) : (
        <ul className="flex flex-col">
          {column.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              now={now}
              current={task.id === currentTaskId}
              onOpenSession={onOpenSession}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
