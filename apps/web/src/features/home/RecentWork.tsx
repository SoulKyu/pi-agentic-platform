import "../../i18n/register-home.ts";
import type { ProjectSummary } from "@pap/contracts";
import { Button, Chip, cn, FOCUS_RING } from "@pap/ui";
import { useEffect, useId, useState } from "react";
import { formatAge } from "../../i18n/age.ts";
import { type Translate, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import type { HomeActions } from "./home-actions.ts";
import { useArchivedLanes } from "./use-archived-lanes.ts";
import {
  filterRows,
  RECENT_FILTERS,
  RECENT_PAGE,
  type RecentFilter,
  type RecentRow,
  recentRows,
} from "./recent-work.vm.ts";

const stateWord = (row: RecentRow, t: Translate): string => {
  switch (row.kind) {
    case "session":
      return t(`session.status.${row.state}`);
    case "lane":
      return t(`home.state.lane.${row.state}`);
    case "fanout":
      return t(`home.state.fanout.${row.state}`);
    case "task":
      return t(`home.state.task.${row.state}`);
  }
};

interface Props {
  readonly project: ProjectSummary | null;
  readonly actions: HomeActions;
}

/** §3.4: the project's sessions, lanes, fan-outs and tasks in one list, 20 at a time; a fan-out row reopens its compare. */
export function RecentWork({ project, actions }: Props) {
  const t = useT();
  const titleId = useId();
  const sessions = useShellStore((state) => state.view.sessions);
  const projects = useShellStore((state) => state.view.projects);
  const loaded = useShellStore((state) => state.view.loaded);
  const broken = useShellStore((state) => state.view.unreadable || state.view.failed !== null);
  const lanes = useLaneStore((state) => state.view.lanes);
  const fanouts = useLaneStore((state) => state.view.fanouts);
  const tasks = useTasksStore((state) => state.view.list);
  const archived = useArchivedLanes();
  const [filter, setFilter] = useState<RecentFilter>("all");
  const [shown, setShown] = useState(RECENT_PAGE);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rows = filterRows(
    recentRows({
      project,
      sessions,
      projects,
      lanes: [...lanes.values(), ...archived.lanes],
      fanouts,
      tasks,
      now,
    }),
    filter,
  );

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-s2">
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <h2 id={titleId} className="label-hud text-muted">
          {t("home.recent.title")}
        </h2>
        <div role="group" aria-label={t("home.recent.filter")} className="flex flex-wrap gap-s1">
          {RECENT_FILTERS.map((one) => (
            <Button
              key={one}
              size="sm"
              variant={filter === one ? "primary" : "ghost"}
              aria-pressed={filter === one}
              onClick={() => {
                setFilter(one);
                setShown(RECENT_PAGE);
              }}
            >
              {t(`home.recent.filter.${one}`)}
            </Button>
          ))}
        </div>
      </div>
      {archived.failed ? (
        <div className="flex items-center gap-s2">
          <p className="text-ui text-muted">{t("home.recent.archivedFailed")}</p>
          <Button variant="secondary" size="sm" onClick={archived.retry}>
            {t("home.recent.archivedRetry")}
          </Button>
        </div>
      ) : null}
      {broken ? (
        <div className="flex items-center gap-s2">
          <p role="alert" className="text-ui text-attn">
            {t("shell.tree.error")}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => getRuntime().subscriptions.resync("shell", "me")}
          >
            {t("shell.tree.retry")}
          </Button>
        </div>
      ) : !loaded ? (
        <p className="text-ui text-muted">{t("shell.tree.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-ui text-muted">{t("home.recent.empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-s1">
            {rows.slice(0, shown).map((row) => {
              const projectName = row.projectId === null ? undefined : projects.get(row.projectId)?.name;
              return (
                <li key={row.key} data-recent-row={row.kind} className="flex items-center gap-s2">
                  <Chip tone="mut" label={t(`home.kind.${row.kind}`)} />
                  <a
                    href={actions.href(row.target)}
                    className={cn("min-w-0 flex-1 truncate text-fg underline", FOCUS_RING)}
                    onClick={(event) => {
                      // A modified or non-primary click is the browser's "open in a new tab".
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey ||
                        event.button !== 0
                      )
                        return;
                      event.preventDefault();
                      actions.open(row.target);
                    }}
                  >
                    {row.title}
                  </a>
                  <span className="text-ui text-muted">{stateWord(row, t)}</span>
                  {project === null && projectName !== undefined ? (
                    <Chip tone="mut" label={projectName} />
                  ) : null}
                  <span className="label-hud text-muted">{formatAge(now, row.at, t)}</span>
                </li>
              );
            })}
          </ul>
          {rows.length > shown ? (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShown((count) => count + RECENT_PAGE)}>
                {t("home.recent.more")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
