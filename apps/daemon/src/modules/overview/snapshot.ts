import {
  type AgentRailState,
  type BoxRef,
  type InboxItem,
  OVERVIEW_LIMITS,
  OWNER_CAPACITY_ROLE,
  type OverviewActivity,
  type OverviewAsk,
  type OverviewBox,
  type OverviewMemberLine,
  OverviewSnapshot,
  type Role,
  type ShellSession,
  type TaskView,
} from "@pap/contracts";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import { cutUnits } from "../../kernel/text.ts";
import { capActivities, fitsMb, isFull, sharedPercent, sortBoxes, stateOf } from "./rules.ts";

type Phase = NonNullable<OverviewBox["phase"]>;

const TEXT_UNITS = 320;
/** The to-handle items read for the asks: far past the few a person has open at once. */
const PENDING_READ = 200;

export interface OverviewAgentFacts {
  readonly id: string;
  readonly name: string;
  readonly threadSessionId: string | null;
  readonly memoryMb: number;
  readonly alwaysOn: boolean;
  /** The rail's word now; null for a rail that is not bound yet. */
  readonly rail: AgentRailState | null;
}

export interface OverviewProjectFacts {
  readonly id: string;
  readonly name: string;
  readonly kind: "box" | "host";
  /** The box's `memoryMb`; 0 for a host project. */
  readonly memoryMb: number;
  readonly alwaysOn: boolean;
}

/** What the users module knows of one account; only the member line's six fields ever leave the snapshot. */
export interface OverviewUserFacts {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly budgetUsd: number | null;
  /** The budget-line figure: API-billed runs today in the owner's zone. */
  readonly spentTodayUsd: number;
  readonly boxes: readonly BoxRef[];
}

/** An agent's thread session, read by id for its owner: the shell window never lists agent threads. */
export interface OverviewThreadFacts {
  readonly running: boolean;
  readonly starting: boolean;
  readonly needsInput: boolean;
  readonly name: string | null;
}

/** What the caller's credential may see beyond its own boxes: member lines need `users:read`, the failure count `pi:admin`. */
export interface OverviewScope {
  readonly members: boolean;
  readonly failures: boolean;
}

export interface OverviewTriggerFacts {
  readonly ownerId: string;
  readonly agentId: string | null;
  readonly projectId: string | null;
  readonly nextFireAt: number | null;
  readonly name: string;
}

/**
 * Everything the snapshot reads, by port. Every read that returns content (boxes, sessions, tasks, items, spend per box) takes
 * the viewer's id; only the host-wide figures and the members' usage have no owner argument (M14).
 */
export interface OverviewSources {
  roleOf(userId: string): Role | null;
  readonly runtime: {
    memory(): { usedMb: number; maxMb: number };
    reservedMb(box: BoxRef): number;
    phase(box: BoxRef): Phase;
  };
  workers(): { used: number; max: number };
  /** Local midnight of the usage zone (the owner's), epoch ms. */
  dayStart(): number;
  readonly spend: {
    todayByBox(
      ownerId: string,
      fromMs: number,
      apiOnly: boolean,
    ): {
      agents: ReadonlyMap<string, number>;
      projects: ReadonlyMap<string, number>;
      totalUsd: number;
      subscription: boolean;
      subscriptionAgents: ReadonlySet<string>;
      subscriptionProjects: ReadonlySet<string>;
    };
    liveRuns(ownerId: string): ReadonlyMap<string, number>;
  };
  agents(ownerId: string): readonly OverviewAgentFacts[];
  projects(ownerId: string): readonly OverviewProjectFacts[];
  sessions(ownerId: string): readonly ShellSession[];
  /** The thread session of one of the owner's agents; null when it is not the owner's or there is none. */
  thread(ownerId: string, sessionId: string): OverviewThreadFacts | null;
  tasks(ownerId: string): readonly TaskView[];
  pending(ownerId: string, limit: number): readonly InboxItem[];
  /** The ids of the owner's projects with an unresolved `box_paused` item. */
  pausedProjects(ownerId: string): readonly string[];
  /** The owner's enabled triggers. */
  triggers(ownerId: string): readonly OverviewTriggerFacts[];
  /** Every member account, disabled ones included. */
  members(): readonly OverviewUserFacts[];
  user(userId: string): OverviewUserFacts | null;
  /** The owner's buffered health failures. */
  failures(ownerId: string): number;
}

const clip = (text: string): string => cutUnits(text, TEXT_UNITS);
const labelOf = (row: ShellSession): string => clip(row.name ?? row.preview ?? "");

/** The nearest `nextFireAt` of the viewer's enabled triggers that name this agent or project. */
function nextRunOf(triggers: readonly OverviewTriggerFacts[], ref: BoxRef): OverviewBox["nextRun"] {
  let best: OverviewTriggerFacts | null = null;
  for (const trigger of triggers) {
    if ((ref.kind === "agent" ? trigger.agentId : trigger.projectId) !== ref.id) continue;
    if (trigger.nextFireAt === null) continue;
    if (best === null || trigger.nextFireAt < (best.nextFireAt ?? Number.POSITIVE_INFINITY)) best = trigger;
  }
  return best === null || best.nextFireAt === null ? null : { at: best.nextFireAt, name: clip(best.name) };
}

/**
 * The Overview's read (R1): the daemon computes every word, figure and order. `viewerId` decides the scope: an owner and a
 * member both read only their own boxes; an owner adds the members' usage lines, a member gets percentages of the shared memory.
 * An id with no role is a member with nothing (M14 fails closed). The result is parsed before it returns.
 */
export function createOverviewSnapshot(
  deps: OverviewSources,
): (viewerId: string, vmUsable: boolean, scope: OverviewScope) => OverviewSnapshot {
  return (viewerId, vmUsable, scope) => {
    const isOwner = deps.roleOf(viewerId) === "owner";
    const spend = deps.spend.todayByBox(viewerId, deps.dayStart(), !isOwner);
    const live = deps.spend.liveRuns(viewerId);
    const sessions = deps.sessions(viewerId);
    const tasks = deps.tasks(viewerId);
    const pending = deps.pending(viewerId, PENDING_READ);
    const paused = new Set(deps.pausedProjects(viewerId));
    const triggers = deps.triggers(viewerId);
    const memory = vmUsable ? deps.runtime.memory() : null;
    const sessionById = new Map(sessions.map((row) => [row.id, row]));
    const taskById = new Map(tasks.map((row) => [row.id, row]));

    const fit = (needMb: number): boolean => memory !== null && fitsMb(memory.usedMb, needMb, memory.maxMb);
    const costOf = (known: ReadonlyMap<string, number>, subscribed: ReadonlySet<string>, id: string) => {
      const costUsd = known.get(id) ?? 0;
      return { costUsd, apiEquivalent: subscribed.has(id) && costUsd > 0 };
    };
    const sessionActivity = (row: ShellSession, kind: "thread" | "session"): OverviewActivity => ({
      kind,
      id: row.id,
      title: labelOf(row),
      since: live.get(row.id) ?? null,
      stoppable: false,
    });
    const taskActivity = (row: TaskView): OverviewActivity => ({
      kind: "task",
      id: row.id,
      title: clip(row.title),
      since: row.startedAt,
      stoppable: true,
    });
    const sessionAsk = (row: ShellSession | undefined): OverviewAsk | null =>
      row === undefined ? null : { source: "session", sessionId: row.id, title: labelOf(row) };

    const agentCard = (agent: OverviewAgentFacts): OverviewBox => {
      const ref: BoxRef = { kind: "agent", id: agent.id };
      const phase = deps.runtime.phase(ref);
      const thread = agent.threadSessionId === null ? null : deps.thread(viewerId, agent.threadSessionId);
      const threadId = agent.threadSessionId;
      const running = tasks.filter((row) => row.agentId === agent.id && row.state === "running");
      const list: OverviewActivity[] = [];
      if (threadId !== null && thread?.running === true)
        list.push({
          kind: "thread",
          id: threadId,
          title: clip(thread.name ?? ""),
          since: live.get(threadId) ?? null,
          stoppable: false,
        });
      list.push(...running.map(taskActivity));
      const item = pending.find((one) => one.agentId === agent.id);
      const ask: OverviewAsk | null =
        item !== undefined
          ? { source: "inbox", item }
          : agent.rail === "needs_input" && threadId !== null && thread?.needsInput === true
            ? { source: "session", sessionId: threadId, title: clip(thread.name ?? "") }
            : null;
      const needMb = agent.memoryMb + VM_OVERHEAD_MB;
      const { activities, more } = capActivities(list);
      return {
        ref,
        name: clip(agent.name),
        state: stateOf({
          waiting: agent.rail === "needs_input" || ask !== null,
          failed: agent.rail === "failed",
          running: agent.rail === "running" || list.length > 0 || phase === "running",
          starting: phase === "starting",
        }),
        phase,
        activities,
        more,
        ask,
        ...costOf(spend.agents, spend.subscriptionAgents, agent.id),
        reservedMb: deps.runtime.reservedMb(ref),
        needMb,
        fits: fit(needMb),
        busy: list.length > 0,
        alwaysOn: agent.alwaysOn,
        nextRun: nextRunOf(triggers, ref),
      };
    };

    const projectCard = (project: OverviewProjectFacts): OverviewBox | null => {
      const isBox = project.kind === "box";
      const ref: BoxRef | null = isBox ? { kind: "project", id: project.id } : null;
      const own = sessions.filter((row) => row.projectId === project.id);
      const runningTasks = tasks.filter((row) => row.projectId === project.id && row.state === "running");
      const taskSessions = new Set(runningTasks.map((row) => row.sessionId));
      const runningSessions = own.filter((row) => row.status === "running" && !taskSessions.has(row.id));
      // A host project has no box to show: it appears only while one of its sessions runs.
      if (!isBox && !own.some((row) => row.status === "running")) return null;
      const phase = ref === null ? null : deps.runtime.phase(ref);
      const list = [
        ...runningSessions.map((row) => sessionActivity(row, "session")),
        ...runningTasks.map(taskActivity),
      ];
      const needsInputTask = tasks.find((row) => row.projectId === project.id && row.needsInput);
      const needsInputSession = own.find((row) => row.needsInput);
      const mine = (item: InboxItem): boolean =>
        (item.taskId !== null && taskById.get(item.taskId)?.projectId === project.id) ||
        (item.sessionId !== null && sessionById.get(item.sessionId)?.projectId === project.id);
      const item = pending.find(mine);
      const ask: OverviewAsk | null =
        item !== undefined ? { source: "inbox", item } : sessionAsk(own.find((row) => row.needsInput));
      const newest = tasks
        .filter((row) => row.projectId === project.id)
        .reduce<TaskView | null>(
          (best, row) => (best === null || row.createdAt > best.createdAt ? row : best),
          null,
        );
      const failedTask =
        newest !== null &&
        newest.state === "failed" &&
        newest.endedAt !== null &&
        list.length === 0 &&
        !own.some((row) => row.id !== newest.sessionId && row.updatedAt > (newest.endedAt ?? 0));
      const isUp = phase === "running" || phase === "starting";
      const needMb = isBox ? project.memoryMb + VM_OVERHEAD_MB : 0;
      const { activities, more } = capActivities(list);
      return {
        ref: ref ?? { kind: "host", id: project.id },
        name: clip(project.name),
        state: stateOf({
          waiting: needsInputTask !== undefined || needsInputSession !== undefined || ask !== null,
          failed: (paused.has(project.id) && !isUp) || failedTask,
          running: list.length > 0 || phase === "running",
          starting: phase === "starting",
        }),
        phase,
        activities,
        more,
        ask,
        ...costOf(spend.projects, spend.subscriptionProjects, project.id),
        reservedMb: ref === null ? 0 : deps.runtime.reservedMb(ref),
        needMb,
        fits: isBox ? fit(needMb) : true,
        busy: list.length > 0,
        alwaysOn: project.alwaysOn,
        nextRun: nextRunOf(triggers, { kind: "project", id: project.id }),
      };
    };

    const agentFacts = deps.agents(viewerId);
    const projectFacts = deps.projects(viewerId);
    const cards = [
      ...agentFacts.map(agentCard),
      ...projectFacts.map(projectCard).filter((card): card is OverviewBox => card !== null),
    ];
    const ownBoxes: BoxRef[] = [
      ...agentFacts.map((agent): BoxRef => ({ kind: "agent", id: agent.id })),
      ...projectFacts
        .filter((project) => project.kind === "box")
        .map((project): BoxRef => ({ kind: "project", id: project.id })),
    ];
    const reservedOf = (boxes: readonly BoxRef[]): number =>
      boxes.reduce((sum, box) => sum + deps.runtime.reservedMb(box), 0);

    const common = { boxes: sortBoxes(cards).slice(0, OVERVIEW_LIMITS.boxes), vmUsable };
    if (!isOwner) {
      const me = deps.user(viewerId);
      return OverviewSnapshot.parse({
        ...common,
        capacity: {
          role: "member",
          sharedPercent: memory === null ? null : sharedPercent(memory.usedMb, memory.maxMb),
          yourMb: reservedOf(ownBoxes),
          cost: { usd: me?.spentTodayUsd ?? 0, budgetUsd: me?.budgetUsd ?? null },
        },
        members: [],
      });
    }
    const members = deps.members();
    const showLines = scope.members;
    const lines: OverviewMemberLine[] = members
      .filter((member) => !member.disabled)
      .sort((a, b) => a.username.localeCompare(b.username))
      .slice(0, OVERVIEW_LIMITS.members)
      .map((member) => ({
        userId: member.id,
        name: clip(member.username),
        activeBoxes: member.boxes.filter((box) => deps.runtime.phase(box) === "running").length,
        reservedMb: reservedOf(member.boxes),
        costUsd: member.spentTodayUsd,
        budgetUsd: member.budgetUsd,
      }));
    const membersUsd = members.reduce((sum, member) => sum + member.spentTodayUsd, 0);
    return OverviewSnapshot.parse({
      ...common,
      capacity: {
        role: OWNER_CAPACITY_ROLE,
        memory: memory === null ? null : { ...memory, full: isFull(memory.usedMb, memory.maxMb) },
        workers: deps.workers(),
        cost: { totalUsd: spend.totalUsd + membersUsd, membersUsd, apiEquivalent: spend.subscription },
        failures: scope.failures ? deps.failures(viewerId) : null,
      },
      members: showLines ? lines : [],
    });
  };
}
