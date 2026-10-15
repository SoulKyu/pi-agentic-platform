import { Spinner, useIsPhone } from "@pap/ui";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { groupColumns } from "./board.vm.ts";
import { BoardHeader } from "./BoardHeader.tsx";
import { EmptyBoard } from "./EmptyBoard.tsx";
import { FailuresBanner } from "./FailuresBanner.tsx";
import { ProjectColumn } from "./ProjectColumn.tsx";

export interface TasksBoardProps {
  onOpenSession(sessionId: string): void;
  onOpenTrigger(triggerId: string): void;
  onNewTrigger(projectId: string): void;
}

/**
 * The Tasks board (decision 31, board 11 §2): a header with the counts and the global pause, the failed background
 * jobs, then one column per project. Phones stack the columns. Sessions and triggers open through the pane's callbacks.
 */
export function TasksBoard({ onOpenSession, onOpenTrigger, onNewTrigger }: TasksBoardProps) {
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
  const columns = useMemo(() => groupColumns(view.list, view.triggers, projects), [view, projects]);

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
        </div>
        {view.truncated ? <p className="text-ui text-muted">{t("automation.board.truncated")}</p> : null}
      </div>
    </section>
  );
}
