import { type BoxRef, DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import type { Clock } from "./kernel/clock.ts";
import type { Db } from "./kernel/db/database.ts";
import type { BoxControl, ProjectBoxSource } from "./kernel/boxes.ts";
import type { LaunchRegistry } from "./kernel/launches.ts";
import type { Logger } from "./kernel/logger.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import type { AgentRuntime, VmStatus } from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";
import type { AuthModule } from "./modules/auth/index.ts";
import type { AutomationModule } from "./modules/automation/index.ts";
import type { HealthModule } from "./modules/health/index.ts";
import type { Inbox } from "./modules/inbox/index.ts";
import {
  createOverviewModule,
  type OverviewModule,
  type OverviewUserFacts,
} from "./modules/overview/index.ts";
import type { ProjectsPort } from "./modules/projects/index.ts";
import { createBoxSpend, type RunsService, startOfLocalDay } from "./modules/runs/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsPort } from "./modules/settings/index.ts";
import type { MemberLine } from "./compose-boxes-budget.ts";
import { memberCapOf } from "./compose-boxes-budget.ts";

/** The most `box_paused` items read for one owner: the projects cap. */
const PAUSED_READ = 600;

type Closers = Array<{ readonly name: string; close(): void | Promise<void> }>;

/** What the Overview reads, once the modules it reads exist. */
export interface OverviewComposition {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot" | "hasSubscribers" | "onLastSubscriberLeft">;
  readonly closers: Closers;
  readonly auth: Pick<AuthModule, "roleOf" | "ownerId" | "users" | "budgetOf" | "isDisabled">;
  readonly agentsVm: {
    readonly runtime: AgentRuntime;
    readonly launches: Pick<LaunchRegistry, "onChange">;
    readonly status: Pick<VmStatus, "usable">;
  };
  readonly m10: { readonly runs: Pick<RunsService, "port">; readonly health: Pick<HealthModule, "count"> };
  readonly m10Late: {
    readonly automation: Pick<AutomationModule, "activeTasks" | "triggers" | "events" | "onTriggerChanged">;
    readonly inbox: Pick<Inbox, "pendingToHandle" | "unresolvedRefs" | "onItem">;
  };
  readonly m11: {
    readonly agents: Pick<AgentsPort, "list" | "state" | "onChange">;
    readonly onRailChange: (listener: (ownerId: string) => void) => () => void;
  };
  readonly sessions: Pick<SessionsModule, "shellRows" | "threadOf" | "onStatus" | "automation">;
  readonly projects: {
    readonly port: Pick<ProjectsPort, "all" | "onChange" | "onRemoved" | "onAlwaysOnChange">;
  };
  readonly boxes: {
    readonly control: Pick<BoxControl, "onPhase">;
    readonly workspace: { readonly boxes: () => Pick<ProjectBoxSource, "ownerBoxes" | "box"> };
  };
  readonly settings: { readonly port: Pick<SettingsPort, "automation"> };
  readonly memberLine: Pick<MemberLine, "memberSpentToday">;
}

/**
 * The Overview's composition (decision 147): the ports the snapshot reads, and every existing change notice turned into one
 * coalesced tick. Nothing is polled: a source that moves tells `changed()`, and the module sends at most one tick a second
 * to each open viewer.
 */
export function composeOverview(modules: OverviewComposition): OverviewModule {
  const { auth, agentsVm, m10, m10Late, m11, sessions, projects, boxes, settings, memberLine } = modules;
  const { runtime } = agentsVm;
  const spend = createBoxSpend({ db: modules.db, clock: modules.clock });
  const capOf = memberCapOf(auth);
  const boxesSource = () => boxes.workspace.boxes();

  const userFacts = (id: string): OverviewUserFacts | null => {
    const row = auth.users().find((user) => user.id === id);
    if (!row) return null;
    const refs: BoxRef[] = [
      ...boxesSource()
        .ownerBoxes(id)
        .map((boxId): BoxRef => ({ kind: "project", id: boxId })),
      ...m11.agents.list(id).map((agent): BoxRef => ({ kind: "agent", id: agent.id })),
    ];
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      disabled: row.disabledAt !== null,
      budgetUsd: capOf(row.id),
      spentTodayUsd: memberLine.memberSpentToday(row.id),
      boxes: refs,
    };
  };

  const overview = createOverviewModule({
    clock: modules.clock,
    logger: modules.logger,
    hub: modules.hub,
    vmUsable: () => agentsVm.status.usable(),
    roleOf: auth.roleOf,
    runtime,
    workers: () => sessions.automation.workers(),
    dayStart() {
      const ownerId = auth.ownerId();
      const zone = ownerId === null ? null : settings.port.automation(ownerId).timezone;
      return startOfLocalDay(modules.clock.now(), zone);
    },
    spend,
    agents: (ownerId) =>
      m11.agents.list(ownerId).map((agent) => ({
        id: agent.id,
        name: agent.name,
        threadSessionId: agent.threadSessionId,
        memoryMb: agent.input?.resources.memoryMb ?? DEFAULT_AGENT_RESOURCES.memoryMb,
        alwaysOn: agent.input?.alwaysOn ?? false,
        rail: m11.agents.state(ownerId, agent.id),
      })),
    projects: (ownerId) =>
      projects.port.all(ownerId).map((project) => {
        const box = project.kind === "box" ? boxesSource().box(project.id) : null;
        return {
          id: project.id,
          name: project.name,
          kind: project.kind === "box" ? "box" : "host",
          memoryMb: box?.resources.memoryMb ?? 0,
          alwaysOn: box?.alwaysOn ?? false,
        };
      }),
    sessions: (ownerId) => sessions.shellRows(ownerId),
    thread: (ownerId, sessionId) => sessions.threadOf(ownerId, sessionId),
    tasks: (ownerId) => m10Late.automation.activeTasks(ownerId),
    pending: (ownerId, limit) => m10Late.inbox.pendingToHandle(ownerId, limit),
    pausedProjects: (ownerId) => m10Late.inbox.unresolvedRefs(ownerId, "box_paused", PAUSED_READ),
    triggers: (ownerId) => m10Late.automation.triggers.listEnabledOf(ownerId),
    members: () =>
      auth
        .users()
        .filter((row) => row.role === "member")
        .flatMap((row) => userFacts(row.id) ?? []),
    user: userFacts,
    failures: (ownerId) => m10.health.count(ownerId),
  });

  const tell = (): void => overview.changed();
  const stops = [
    runtime.onPhase(tell),
    boxes.control.onPhase(tell),
    agentsVm.launches.onChange(tell),
    m10.runs.port.onRunStart(tell),
    m10.runs.port.onRunEnd(tell),
    m10.runs.port.onLiveCost(tell),
    m10Late.automation.events.on(tell),
    m10Late.automation.onTriggerChanged(tell),
    m10Late.inbox.onItem(tell),
    sessions.onStatus(tell),
    m11.onRailChange(tell),
    m11.agents.onChange(tell),
    projects.port.onChange(tell),
    projects.port.onAlwaysOnChange(tell),
    projects.port.onRemoved(tell),
  ];
  modules.closers.push({
    name: "overview",
    close() {
      for (const stop of stops.splice(0)) stop();
      overview.stop();
    },
  });
  return overview;
}
