import "../../i18n/register-sidebar.ts";
import type { ShellSession } from "@pap/contracts";
import { Banner, Button, Collapsible, TextField } from "@pap/ui";
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { errorKey, plural, useLocale, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useEffectiveProject } from "../../stores/current-project.ts";
import { retryLanes } from "../../stores/lane-feed.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { ArchivedLanesEntry, type ArchivedLanesProps } from "./ArchivedLanesEntry.tsx";
import { ArchivedShelf } from "./ArchivedShelf.tsx";
import { Loading } from "./Loading.tsx";
import { useFocusFallback } from "./menu-focus.ts";
import { LaneRow } from "./LaneRow.tsx";
import { ProjectHeading } from "./ProjectHeading.tsx";
import { SessionRow } from "./SessionRow.tsx";
import { buildTree, clampShown, ROWS_PER_PROJECT } from "./tree.vm.ts";

interface ProjectTreeProps {
  onPick(id: string): void;
  /** A project's "New session here" went to the start: close the drawer, or leave the Lists section. */
  onNewSession?(): void;
  /** The palette's effective chord, formatted ("Ctrl+K"); null when it has none. */
  readonly chord: string | null;
  /** The archived-lanes list's chunk, from the shell; without it the closing entry is not shown. */
  readonly loadArchivedLanes?: () => Promise<{ default: ComponentType<ArchivedLanesProps> }>;
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

/** How long a change may take before the tree says it is saving (DESIGN §7.3: nothing under 100 ms). */
const SAVING_AFTER_MS = 100;

/** A polite live region: "Saving…" once a change has waited for its answer for 100 ms. */
function SavingStatus({ pending }: { readonly pending: boolean }) {
  const t = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), SAVING_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [pending]);
  const saying = pending && slow;
  // Always in the layout, so a screen reader has the region before its first message; invisible while empty.
  return (
    <div role="status" aria-live="polite" className={saying ? "text-ui text-muted" : "sr-only"}>
      {saying ? t("sidebar.saving") : ""}
    </div>
  );
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
export default function ProjectTree({ onPick, onNewSession, chord, loadArchivedLanes }: ProjectTreeProps) {
  const t = useT();
  const locale = useLocale();
  const view = useShellStore((state) => state.view);
  const laneView = useLaneStore((state) => state.view);
  const current = useEffectiveProject();
  const now = useNow(60_000);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const uid = useId();
  const box = useRef<HTMLDivElement>(null);
  const pending = view.pending.size > 0;
  useFocusFallback(pending, () => box.current?.querySelector("input") ?? null);
  const model = buildTree({
    sessions: view.sessions.values(),
    projects: view.projects,
    filter,
    projectId: current?.id ?? null,
    shown,
    now,
    lanes: { items: laneView.lanes.values(), archived: laneView.archived },
  });
  const broken = view.unreadable || view.failed !== null;
  const filtering = filter.trim() !== "";
  // A session archived here counts at once: the daemon's count follows (M4R84).
  const archivedHeld = [...view.sessions.values()].filter((session) => session.archivedAt !== null).length;
  const archived = Math.max(view.archived, archivedHeld);
  const order = model.groups.flatMap((group) => (group.project ? [group.project] : []));
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
  else if (laneView.failed !== null)
    banner = (
      <Banner
        tone="capacity"
        title={t("sidebar.lanesFailed")}
        actions={
          <Button variant="secondary" size="sm" onClick={() => retryLanes(getRuntime().subscriptions)}>
            {t("sidebar.retry")}
          </Button>
        }
      >
        {t(errorKey(laneView.failed))}
      </Banner>
    );
  else if (view.unreadable)
    banner = <Banner tone="capacity" title={t("sidebar.unreadable")} actions={retryAction} />;

  return (
    <div ref={box} data-project-tree className="flex flex-col gap-s3 p-s3">
      <TextField label={t("sidebar.filter")} value={filter} onChange={setFilter} />
      <SavingStatus pending={pending} />
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
              project={group.project}
              order={order}
              movable={!filtering}
              onNewSession={onNewSession}
            />
            {group.lanes.length > 0 ? (
              <ul
                aria-label={t("sidebar.lanes", { name: group.project?.name ?? t("sidebar.otherFolders") })}
                className="flex flex-col gap-s1"
              >
                {group.lanes.map((row) => (
                  <LaneRow key={row.lane.id} row={row} now={now} onPick={onPick} />
                ))}
              </ul>
            ) : null}
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
      {archived > 0 && !filtering ? (
        <ArchivedShelf count={archived} chord={chord} now={now} onPick={onPick} />
      ) : null}
      {archived > 0 && filtering ? (
        <p className="text-ui text-muted">{t("sidebar.archivedNotSearched")}</p>
      ) : null}
      {model.archivedLanes > 0 && loadArchivedLanes ? (
        <ArchivedLanesEntry count={model.archivedLanes} load={loadArchivedLanes} onPick={onPick} />
      ) : null}
      {model.empty && view.loaded && !broken ? (
        <p className="text-ui text-muted">{t(filtering ? "sidebar.noMatch" : "sidebar.empty")}</p>
      ) : null}
    </div>
  );
}
