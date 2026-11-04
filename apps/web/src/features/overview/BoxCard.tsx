import type { OverviewActivity, OverviewBox, OverviewSnapshot } from "@pap/contracts";
import { Button, Chip, Icon, IconAgents, IconFolder, IconPin, cn, formatCost } from "@pap/ui";
import type { ReactNode } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { LaunchLine } from "./LaunchLine.tsx";
import { TaskStop } from "./TaskStop.tsx";
import type { OverviewCallbacks } from "./callbacks.ts";
import {
  PHASE_TONE,
  STATE_TONE,
  type ActiveBox,
  activityLine,
  askWords,
  nextRunLine,
  sizeText,
} from "./overview.vm.ts";

interface Props {
  readonly box: ActiveBox;
  readonly capacity: OverviewSnapshot["capacity"];
  readonly now: number;
  readonly on: OverviewCallbacks;
}

/** The box's own picture when the route layer gave none: an agent's bot, a project's folder. */
export function BoxGlyph({ box, on }: { readonly box: OverviewBox; readonly on: OverviewCallbacks }) {
  if (box.ref.kind === "agent" && on.renderAvatar) return <>{on.renderAvatar(box.ref.id)}</>;
  return (
    <span className="text-muted">
      <Icon icon={box.ref.kind === "agent" ? IconAgents : IconFolder} size={20} />
    </span>
  );
}

export function openBox(box: OverviewBox, on: OverviewCallbacks): void {
  if (box.ref.kind === "agent") on.openAgent(box.ref.id);
  else on.openProject(box.ref.id);
}

function Activity({
  box,
  activity,
  on,
}: {
  readonly box: OverviewBox;
  readonly activity: OverviewActivity;
  readonly on: OverviewCallbacks;
}) {
  const t = useT();
  const locale = useLocale();
  // An agent's thread opens through the agent tab (the app never lists it as a session); its tasks and a project's sessions open as such.
  const open = () => {
    if (activity.kind === "task") on.openTask(activity.id);
    else if (box.ref.kind === "agent" && activity.kind === "thread") on.openAgent(box.ref.id);
    else on.openSession(activity.id);
  };
  return (
    <li className="flex items-start justify-between gap-s2">
      <span className="min-w-0 flex-1">
        <Button variant="ghost" size="sm" truncate onClick={open}>
          {activityLine(activity, locale, t)}
        </Button>
      </span>
      {activity.kind === "task" && activity.stoppable ? <TaskStop taskId={activity.id} /> : null}
    </li>
  );
}

function Ask({ box, on }: { readonly box: OverviewBox; readonly on: OverviewCallbacks }) {
  const t = useT();
  const { ask } = box;
  if (ask === null) return null;
  const { category, detail } = askWords(ask, t);
  const answer = () => {
    if (ask.source === "inbox") on.revealInbox(ask.item.id);
    else if (box.ref.kind === "agent") on.openAgent(box.ref.id);
    else on.openSession(ask.sessionId);
  };
  return (
    <div
      data-ask=""
      className="flex flex-wrap items-center justify-between gap-s2 rounded-sm border border-attn-line bg-attn-tint px-s2 py-s1"
    >
      <p className="min-w-0 flex-1 text-ui">
        <span className="font-semibold text-attn-title">{category}</span>
        {category !== "" && detail !== "" ? " · " : ""}
        <span className="break-words text-fg">{detail}</span>
      </p>
      <Button variant="primary" size="sm" onClick={answer}>
        {t("overview.answer")}
      </Button>
    </div>
  );
}

/** One live box: who it is, what it is doing, what waits for you, what it costs. Everything it says came with the snapshot (R1). */
export function BoxCard({ box, capacity, now, on }: Props) {
  const t = useT();
  const locale = useLocale();
  const extra: ReactNode = on.actions?.(box, capacity);
  return (
    <article
      data-box-card={`${box.ref.kind}:${box.ref.id}`}
      data-state={box.state}
      className={cn(
        "flex min-w-pane flex-1 flex-col gap-s2 rounded-md border bg-surface p-s3",
        box.state === "waiting" ? "border-attn-line" : "border-border",
      )}
    >
      <header className="flex flex-wrap items-center gap-s2">
        <BoxGlyph box={box} on={on} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Button variant="ghost" size="sm" truncate onClick={() => openBox(box, on)}>
            {box.name}
          </Button>
          <span className="label-hud px-s2 text-muted">{t(`overview.kind.${box.ref.kind}`)}</span>
        </div>
        <Chip tone={STATE_TONE[box.state]} label={t(`overview.state.${box.state}`)} dot />
        {box.phase === null ? null : (
          <span data-phase="">
            <Chip tone={PHASE_TONE[box.phase]} label={t(`overview.phase.${box.phase}`)} />
          </span>
        )}
      </header>
      {box.ref.kind === "host" ? <p className="text-ui text-muted">{t("overview.card.noBox")}</p> : null}
      {box.state === "starting" && box.ref.kind !== "host" ? (
        <LaunchLine box={{ kind: box.ref.kind, id: box.ref.id }} />
      ) : null}
      <Ask box={box} on={on} />
      {box.activities.length > 0 ? (
        <ul className="flex flex-col">
          {box.activities.map((activity) => (
            <Activity key={`${activity.kind}:${activity.id}`} box={box} activity={activity} on={on} />
          ))}
        </ul>
      ) : null}
      {box.more > 0 ? (
        <p className="text-ui text-muted">{t("overview.card.more", { count: box.more })}</p>
      ) : null}
      <footer className="mt-auto flex flex-wrap items-center gap-x-s3 gap-y-s1 text-ui text-muted">
        <span className="font-mono tabular-nums">{formatCost(box.costUsd)}</span>
        {box.apiEquivalent ? <span>{t("overview.band.apiEquivalent")}</span> : null}
        {box.reservedMb > 0 ? (
          <span className="font-mono tabular-nums">{sizeText(box.reservedMb, locale, t)}</span>
        ) : null}
        {box.alwaysOn ? (
          <span className="inline-flex items-center gap-s1">
            <Icon icon={IconPin} size={14} />
            <Chip tone="mut" label={t("overview.alwaysOn")} />
          </span>
        ) : null}
        {box.nextRun === null ? null : <span>{nextRunLine(box.nextRun, now, locale, t)}</span>}
        {extra === undefined || extra === null ? null : <span className="ml-auto flex gap-s2">{extra}</span>}
      </footer>
    </article>
  );
}
