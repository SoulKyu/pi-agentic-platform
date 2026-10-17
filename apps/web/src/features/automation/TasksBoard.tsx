import { Spinner, useIsPhone, type AvatarStyle } from "@pap/ui";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { agentColumns } from "./agent-columns.vm.ts";
import { AgentColumn } from "./AgentColumn.tsx";
import { groupColumns } from "./board.vm.ts";
import { BoardHeader } from "./BoardHeader.tsx";
import { EmptyBoard } from "./EmptyBoard.tsx";
import { FailuresBanner } from "./FailuresBanner.tsx";
import { ProjectColumn } from "./ProjectColumn.tsx";

export interface TasksBoardProps {
  onOpenSession(sessionId: string): void;
  onOpenTrigger(triggerId: string): void;
  /** A project id, or `agent:<id>` from an agent's column. */
  onNewTrigger(projectId: string): void;
  onOpenAgent?(agentId: string): void;
  readonly avatarStyle?: AvatarStyle;
}

/**
 * The Tasks board (decision 31, board 11 §2): a header with the counts and the global pause, the failed background
 * jobs, then one column per project. Phones stack the columns. Sessions and triggers open through the pane's callbacks.
 */
export function TasksBoard({
  onOpenSession,
  onOpenTrigger,
  onNewTrigger,
  onOpenAgent,
  avatarStyle,
}: TasksBoardProps) {
  const t = useT();
  const phone = useIsPhone();
  const view = useTasksStore((state) => state.view);
  const projects = useShellStore((state) => state.view.projects);
  const [now, setNow] = useState(() => Date.now());
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const agents = useAgents((state) => state.agents);
  const columns = useMemo(
    () => groupColumns(view.list, view.triggers, projects, new Set(agents.map((agent) => agent.id))),
    [view, projects, agents],
  );
  const perAgent = useMemo(() => agentColumns(view.list, view.triggers, agents), [view, agents]);

  if (!view.loaded || view.counts === null) {
    return (
      <section data-tasks-pane="" data-tasks-board="" className="flex min-h-0 flex-1 items-start p-s3">
        <Spinner label={t("automation.board.loading")} />
      </section>
    );
  }

  return (
    <section data-tasks-pane="" data-tasks-board="" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <BoardHeader counts={view.counts} />
      <div className="flex flex-col gap-s3 p-s3">
        <FailuresBanner failures={view.failures} now={now} />
        {view.triggers.length === 0 ? <EmptyBoard onNewTrigger={onNewTrigger} /> : null}
        <div
          data-slot="board-columns"
          data-layout={phone ? "stack" : "grid"}
          className={phone ? "flex flex-col gap-s3" : "flex flex-wrap items-start gap-s3"}
        >
          {columns.map((column) => (
            <div key={column.key} className={phone ? "min-w-0" : "min-w-pane flex-1"}>
              <ProjectColumn
                column={column}
                now={now}
                currentTaskId={opened}
                onOpenSession={(sessionId, taskId) => {
                  setOpened(taskId);
                  onOpenSession(sessionId);
                }}
                onOpenTrigger={onOpenTrigger}
                onNewTrigger={onNewTrigger}
              />
            </div>
          ))}
          {perAgent.map((column) => (
            <div key={column.agent.id} className={phone ? "min-w-0" : "min-w-pane flex-1"}>
              <AgentColumn
                column={column}
                now={now}
                currentTaskId={opened}
                avatarStyle={avatarStyle ?? "outlined"}
                onOpenSession={(sessionId, taskId) => {
                  setOpened(taskId);
                  onOpenSession(sessionId);
                }}
                onOpenTrigger={onOpenTrigger}
                onNewTrigger={onNewTrigger}
                {...(onOpenAgent ? { onOpenAgent } : {})}
              />
            </div>
          ))}
        </div>
        {view.truncated ? <p className="text-ui text-muted">{t("automation.board.truncated")}</p> : null}
      </div>
    </section>
  );
}
