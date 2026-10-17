import type { AvatarStyle } from "@pap/ui";
import { Avatar, formatCost } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { AgentColumn as AgentColumnView } from "./agent-columns.vm.ts";
import { costToday, shown } from "./board.vm.ts";
import { TaskCard } from "./TaskCard.tsx";
import { TriggerStrip } from "./TriggerStrip.tsx";

interface AgentColumnProps {
  readonly column: AgentColumnView;
  readonly now: number;
  readonly currentTaskId: string | null;
  readonly avatarStyle: AvatarStyle;
  onOpenSession(sessionId: string, taskId: string): void;
  onOpenTrigger(triggerId: string): void;
  onNewTrigger(scope: string): void;
  onOpenAgent?(agentId: string): void;
}

/** One agent (M11R128, decision 31): avatar, slots in use, cost today, its trigger strip, then its tasks. */
export function AgentColumn({
  column,
  now,
  currentTaskId,
  avatarStyle,
  onOpenSession,
  onOpenTrigger,
  onNewTrigger,
  onOpenAgent,
}: AgentColumnProps) {
  const t = useT();
  const { agent } = column;
  const name = shown(agent.name, "name");
  return (
    <section
      data-slot="agent-column"
      data-column={agent.id}
      aria-label={name}
      className="flex min-w-0 flex-col rounded-md border border-border-strong bg-surface"
    >
      <header className="flex flex-wrap items-center gap-s2 border-b border-border px-s3 py-s2">
        <Avatar initials={agent.initials} name={name} avatarStyle={avatarStyle} />
        <h2 className="min-w-0 flex-1 break-words text-ui font-semibold text-fg">{name}</h2>
        <span className="font-mono text-label text-muted tabular-nums">
          {t("automation.column.running", { count: column.running })}
        </span>
        <span className="font-mono text-label text-muted tabular-nums">
          {t("automation.column.cost", { cost: formatCost(costToday(column.tasks, now)) })}
        </span>
      </header>
      <TriggerStrip
        triggers={column.triggers}
        projectId={`agent:${agent.id}`}
        projectName={name}
        onOpenTrigger={onOpenTrigger}
        onNewTrigger={onNewTrigger}
      />
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
              {...(onOpenAgent ? { onOpenAgent } : {})}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
