import "./register-space-catalog.ts";
import type { TaskView } from "@pap/contracts";
import { Button, InlineError, usePendingAction } from "@pap/ui";
import { useEffect, useState } from "react";
import { errorKey, useLocale, useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { agentById } from "../../stores/agents-reducer.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { feedTasks } from "../../stores/tasks-feed.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { lineOf } from "./untrusted-text.ts";
import { useNow } from "./use-agent-space.ts";

const CLOCK_MS = 30_000;
/** The strip shows this many rows; the rest is counted (a busy agent never grows the thread's footer). */
const MAX_ROWS = 10;

const isPending = (task: TaskView, agentId: string): boolean => {
  if (task.origin === "delegate")
    return task.requestedBy === agentId && ["queued", "running", "limited"].includes(task.state);
  return (
    task.origin === "remind" &&
    task.target === "thread" &&
    task.agentId === agentId &&
    task.state === "queued"
  );
};

/**
 * This agent's outgoing work that is still queued or running elsewhere (M11R121): the delegations it asked for and its
 * reminders, from M10's `tasks` stream. The stream is opened with the tab and closed with it. A task's words are untrusted:
 * text, hidden characters removed.
 */
export function PendingStrip({ agentId }: { readonly agentId: string }) {
  const t = useT();
  useEffect(() => feedTasks(getRuntime().subscriptions, () => reportClientIssue("tasks_feed_failed")), []);
  const list = useTasksStore((state) => state.view.list);
  const now = useNow(CLOCK_MS);
  const rows = list.filter((task) => isPending(task, agentId));
  if (rows.length === 0) return null;
  return (
    <ul data-pending-strip="" aria-label={t("agentCompose.strip.region")} className="flex flex-col gap-s1">
      {rows.slice(0, MAX_ROWS).map((task) => (
        <PendingRow key={task.id} task={task} now={now} />
      ))}
      {rows.length > MAX_ROWS ? (
        <li className="text-ui text-muted">{t("agentCompose.strip.more", { n: rows.length - MAX_ROWS })}</li>
      ) : null}
    </ul>
  );
}

function PendingRow({ task, now }: { readonly task: TaskView; readonly now: number }) {
  const t = useT();
  const target = useAgents((view) => (task.agentId ? agentById(view, task.agentId) : undefined));
  const cancel = usePendingAction();
  const [problem, setProblem] = useState<string | null>(null);
  const minutes = Math.floor(Math.max(0, now - task.createdAt) / 60_000);
  const age =
    task.state === "running"
      ? t("agentCompose.strip.running")
      : task.state === "limited"
        ? t("agentCompose.strip.limited")
        : minutes < 1
          ? t("agentCompose.strip.queuedNow")
          : t("agentCompose.strip.queued", { n: minutes });
  const locale = useLocale();
  const remindAt =
    task.notBefore == null
      ? t("agentCompose.strip.remind")
      : t("agentCompose.strip.remindAt", {
          time: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(task.notBefore),
        });
  const what =
    task.origin === "delegate"
      ? t("agentCompose.strip.delegate", { name: target?.name ?? task.agentId ?? "?" })
      : remindAt;
  const said = task.origin === "delegate" ? task.detail : task.note;
  const words = said ? lineOf(said) : null;
  const run = () =>
    void cancel.run(async () => {
      setProblem(null);
      const { rpc } = getRuntime();
      try {
        await rpc.call("automation.tasks.cancel", { taskId: task.id }, { commandId: rpc.newCommandId() });
      } catch (failure) {
        setProblem(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
      }
    });
  return (
    <li
      data-pending-row=""
      className="flex flex-wrap items-center gap-s2 rounded-md border border-border bg-surface px-s3 py-s2"
    >
      <p className="min-w-0 flex-1 truncate text-ui text-fg">
        <span className="font-semibold">{what}</span>
        {words === null ? null : <span className="text-muted"> «{words}»</span>}
        <span className="text-muted"> · {age}</span>
      </p>
      <Button size="sm" pendingSince={cancel.since} onClick={run}>
        {t("agentCompose.strip.cancel")}
      </Button>
      {problem === null ? null : (
        <div className="w-full">
          <InlineError announce="action">{problem}</InlineError>
        </div>
      )}
    </li>
  );
}
