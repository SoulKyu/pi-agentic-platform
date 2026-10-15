import { cn, FOCUS_RING, IconButton, IconChevronDown, IconChevronRight } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { LANE_DOT } from "../../lib/lane-status-view.ts";
import { SessionRow } from "./SessionRow.tsx";
import type { TreeLane } from "./tree.vm.ts";

interface LaneRowProps {
  readonly row: TreeLane;
  readonly now: number;
  /** A lane or one of its sessions was picked: the drawer closes. */
  onPick(id: string): void;
}

/** One lane under its project: status dot and word, title, branch, +ahead, ●dirty, #PR; expands to its sessions. */
export function LaneRow({ row, now, onPick }: LaneRowProps) {
  const t = useT();
  const { lane, status } = row;
  const [open, setOpen] = useState(false);
  const listId = useId();
  const dot = LANE_DOT[status];
  const facts = lane.facts;
  return (
    <li className="flex flex-col gap-s1">
      <div className="flex items-center gap-s1">
        <IconButton
          icon={open ? IconChevronDown : IconChevronRight}
          size="sm"
          label={t(open ? "sidebar.lane.collapse" : "sidebar.lane.expand", { branch: lane.branch })}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((current) => !current)}
        />
        <Link
          to="/lane/$laneId"
          params={{ laneId: lane.id }}
          onClick={() => onPick(lane.id)}
          // The router marks the open lane `aria-current="page"`; the agent rule and the raised surface show it (board 05).
          activeProps={{ className: "border-agent bg-surface-2" }}
          inactiveProps={{ className: "border-transparent" }}
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-s1 rounded-sm border-l-2 px-s2 py-s1 text-ui pointer-coarse:min-h-11",
            FOCUS_RING,
          )}
        >
          <span className="flex min-w-0 items-center gap-s1">
            {dot ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} /> : null}
            <span data-lane-title className="min-w-0 truncate">
              {lane.title || lane.branch}
            </span>
            <span data-lane-status className="label-hud shrink-0 text-muted">
              {t(`shell.lane.status.${status}`)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-s2 font-mono text-label text-muted tabular-nums">
            <span data-lane-branch className="min-w-0 truncate">
              {lane.branch}
            </span>
            {facts?.ahead ? (
              <span>
                <span aria-hidden>+{facts.ahead}</span>
                <span className="sr-only">{t("sidebar.lane.ahead", { count: facts.ahead })}</span>
              </span>
            ) : null}
            {facts?.dirty ? (
              <span>
                <span aria-hidden>●{facts.dirty}</span>
                <span className="sr-only">{t("sidebar.lane.dirty", { count: facts.dirty })}</span>
              </span>
            ) : null}
            {lane.pr ? (
              <span>
                <span aria-hidden>#{lane.pr.number}</span>
                <span className="sr-only">{t("sidebar.lane.pr", { number: lane.pr.number })}</span>
              </span>
            ) : null}
          </span>
        </Link>
      </div>
      <div id={listId} hidden={!open}>
        {open ? (
          row.sessions.length > 0 ? (
            <ul
              aria-label={t("sidebar.lane.sessions", { branch: lane.branch })}
              className="flex flex-col gap-s1 pl-s4"
            >
              {row.sessions.map((session) => (
                <SessionRow key={session.id} session={session} now={now} onPick={onPick} />
              ))}
            </ul>
          ) : (
            <p className="pl-s4 text-ui text-muted">{t("sidebar.lane.noSessions")}</p>
          )
        ) : null}
      </div>
    </li>
  );
}
