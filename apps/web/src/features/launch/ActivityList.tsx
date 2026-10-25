import "../../i18n/register-launch.ts";
import type { AgentSummary, LaneView, LaunchView } from "@pap/contracts";
import { Popover } from "@pap/ui/overlays";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { useT } from "../../i18n/index.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useLaunches, formatLaunchTime } from "../../stores/launch-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { stepKey, waitingWords } from "./launch-view.ts";
import { useNow } from "./use-elapsed.ts";

interface Props {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly label: string;
  readonly closeLabel: string;
  readonly trigger: ComponentProps<typeof Popover>["trigger"];
  readonly where: Where;
}

/** Where a row leads: the shell knows the paths, a feature does not import the others. */
export interface Where {
  agentPath(agent: AgentSummary): string;
  lanePath(id: string): string;
}

const ROW = "flex flex-col gap-s1 rounded-sm px-s2 py-s1 text-ui focus-ring can-hover:hover:bg-surface-2";

function Row({
  to,
  onClick,
  name,
  what,
  time,
  onClose,
}: {
  readonly to: string;
  readonly onClick?: () => void;
  readonly name: string;
  readonly what: string;
  readonly time: string;
  onClose(): void;
}) {
  return (
    <li data-activity-row="">
      <Link
        to={to}
        className={ROW}
        onClick={() => {
          onClick?.();
          onClose();
        }}
      >
        <span className="truncate font-semibold text-fg">{name}</span>
        <span className="flex items-baseline justify-between gap-s2 text-muted">
          <span className="min-w-0">{what}</span>
          <span className="shrink-0 font-mono tabular-nums">{time}</span>
        </span>
      </Link>
    </li>
  );
}

function Rows({ onClose, where }: { onClose(): void; where: Where }) {
  const t = useT();
  const now = useNow(true);
  const launches = useLaunches();
  const lanes = [...useLaneStore((state) => state.view.lanes).values()].filter(
    (lane) => lane.state === "creating",
  );
  const projects = useShellStore((state) => state.view.projects);
  const agents = useAgents((view) => view.agents);
  const launchRow = (launch: LaunchView) => {
    const live = launch.steps.find((step) => step.state === "running");
    const agent = launch.box.kind === "agent" ? agents.find((one) => one.id === launch.box.id) : undefined;
    const name =
      launch.box.kind === "agent" ? (agent?.name ?? "") : (projects.get(launch.box.id)?.name ?? "");
    const boxId = launch.box.id;
    return (
      <Row
        key={launch.id}
        to={agent ? where.agentPath(agent) : "/"}
        {...(launch.box.kind === "project"
          ? { onClick: () => useCurrentProject.getState().choose(boxId) }
          : {})}
        name={name}
        what={
          live
            ? t(stepKey(live.step, launch.box.kind))
            : launch.waiting
              ? waitingWords(launch.waiting, now, t).text
              : t("launch.title.project")
        }
        time={formatLaunchTime(now - launch.startedAt)}
        onClose={onClose}
      />
    );
  };
  const laneRow = (lane: LaneView) => (
    <Row
      key={lane.id}
      to={where.lanePath(lane.id)}
      name={lane.title}
      what={t("launch.lane")}
      time={formatLaunchTime(now - lane.createdAt)}
      onClose={onClose}
    />
  );
  return (
    <ul data-activity-list="" className="flex min-h-0 flex-col gap-s1 overflow-y-auto p-s1">
      {launches.map(launchRow)}
      {lanes.map(laneRow)}
    </ul>
  );
}

/** Everything that is starting, building or waiting, one row each with its step or reason, its time and a link to its screen. */
export function ActivityList({ open, onOpenChange, label, closeLabel, trigger, where }: Props) {
  return (
    <Popover open={open} onOpenChange={onOpenChange} label={label} closeLabel={closeLabel} trigger={trigger}>
      <Rows onClose={() => onOpenChange(false)} where={where} />
    </Popover>
  );
}
