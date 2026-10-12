import "../../i18n/register-sidebar.ts";
import type { ShellSession } from "@pap/contracts";
import { Banner, Button, Collapsible, TextField } from "@pap/ui";
import { useEffect, useId, useState, type ReactNode } from "react";
import { errorKey, plural, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { ArchivedShelf } from "./ArchivedShelf.tsx";
import { Loading } from "./Loading.tsx";
import { ProjectHeading } from "./ProjectHeading.tsx";
import { SessionRow } from "./SessionRow.tsx";
import { buildTree, clampShown, ROWS_PER_PROJECT } from "./tree.vm.ts";

interface ProjectTreeProps {
  onPick(id: string): void;
  /** The palette's effective chord, formatted ("Ctrl+K"); null when it has none. */
  readonly chord: string | null;
}

/** The current time, refreshed every `interval` ms so ages and snoozes stay true. */
function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

interface ShelfProps {
  readonly title: string;
  readonly sessions: readonly ShellSession[];
  readonly more: number;
  readonly now: number;
  onPick(id: string): void;
}

/** Snoozed and Settled: closed by default, at most 50 rows with "+N more" past them. */
function Shelf({ title, sessions, more, now, onPick }: ShelfProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-s1">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        trigger={
          <span id={titleId} className="label-hud text-muted">
            {title}
          </span>
        }
      >
        <ul className="flex flex-col gap-s1">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} now={now} onPick={onPick} />
          ))}
        </ul>
        {more > 0 ? <p className="text-ui text-muted">{t("sidebar.shelfMore", { count: more })}</p> : null}
      </Collapsible>
    </section>
  );
}

/** The ⌘B tree: pinned, then projects with their sessions, then the Snoozed, Settled and Archived shelves. */
export default function ProjectTree({ onPick, chord }: ProjectTreeProps) {
  const t = useT();
  const locale = useLocale();
  const view = useShellStore((state) => state.view);
  const now = useNow(60_000);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const uid = useId();
  const model = buildTree({
    sessions: view.sessions.values(),
    projects: view.projects,
    filter,
    projectId: null,
    shown,
    now,
  });
  const broken = view.unreadable || view.failed !== null;
  const filtering = filter.trim() !== "";
  const showMore = (key: string) =>
    setShown((previous) => new Map(previous).set(key, clampShown(previous.get(key)) + ROWS_PER_PROJECT));
  const retry = () => getRuntime().subscriptions.resync("shell", "me");
  const olderLine = (count: number): string =>
    chord === null
      ? plural(locale, "sidebar.olderNoChord", count)
      : plural(locale, "sidebar.older", count, { chord });

  const retryAction = (
    <Button variant="secondary" size="sm" onClick={retry}>
      {t("sidebar.retry")}
    </Button>
  );
  let banner: ReactNode = null;
  if (view.failed !== null)
    banner = (
      <Banner tone="capacity" title={t("sidebar.failed")} actions={retryAction}>
        {t(errorKey(view.failed))}
      </Banner>
    );
  else if (view.unreadable)
    banner = <Banner tone="capacity" title={t("sidebar.unreadable")} actions={retryAction} />;

  return (
    <div data-project-tree className="flex flex-col gap-s3 p-s3">
      <TextField label={t("sidebar.filter")} value={filter} onChange={setFilter} />
      {banner}
      {!view.loaded && !broken ? <Loading label={t("sidebar.loading")} /> : null}
      {model.pinned.length > 0 ? (
        <section aria-labelledby={`${uid}-pinned`} className="flex flex-col gap-s1">
          <h3 id={`${uid}-pinned`} className="label-hud text-muted">
            {t("sidebar.pinned")}
          </h3>
          <ul className="flex flex-col gap-s1">
            {model.pinned.map((session) => (
              <SessionRow key={session.id} session={session} now={now} onPick={onPick} />
            ))}
          </ul>
        </section>
      ) : null}
      {model.groups.map((group, index) => {
        const key = group.project?.id ?? "";
        const heading = `${uid}-g${index}`;
        return (
          <section key={key} data-group={key} aria-labelledby={heading} className="flex flex-col gap-s1">
            <ProjectHeading
              id={heading}
              name={group.project?.name ?? t("sidebar.otherFolders")}
              root={group.project?.root ?? null}
              count={group.project?.sessions ?? group.sessions.length + group.hidden}
            />
            {group.sessions.length > 0 ? (
              <ul className="flex flex-col gap-s1">
                {group.sessions.map((session) => (
                  <SessionRow key={session.id} session={session} now={now} onPick={onPick} />
                ))}
              </ul>
            ) : null}
            {group.hidden > 0 ? (
              <div>
                <Button variant="ghost" size="sm" onClick={() => showMore(key)}>
                  {t("sidebar.showMore")}
                </Button>
              </div>
            ) : null}
            {group.older > 0 ? <p className="text-ui text-muted">{olderLine(group.older)}</p> : null}
          </section>
        );
      })}
      {model.snoozed.length > 0 ? (
        <Shelf
          title={t("sidebar.snoozed", { count: model.snoozed.length + model.snoozedMore })}
          sessions={model.snoozed}
          more={model.snoozedMore}
          now={now}
          onPick={onPick}
        />
      ) : null}
      {model.settled.length > 0 ? (
        <Shelf
          title={t("sidebar.settled", { count: model.settled.length + model.settledMore })}
          sessions={model.settled}
          more={model.settledMore}
          now={now}
          onPick={onPick}
        />
      ) : null}
      {view.archived > 0 && !filtering ? (
        <ArchivedShelf count={view.archived} chord={chord} now={now} onPick={onPick} />
      ) : null}
      {view.archived > 0 && filtering ? (
        <p className="text-ui text-muted">{t("sidebar.archivedNotSearched")}</p>
      ) : null}
      {model.empty && view.loaded && !broken ? (
        <p className="text-ui text-muted">{t(filtering ? "sidebar.noMatch" : "sidebar.empty")}</p>
      ) : null}
    </div>
  );
}
