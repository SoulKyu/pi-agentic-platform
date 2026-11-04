import type { AgentRailState, BoxRef, InboxItem, OverviewBox, ShellSession, TaskView } from "@pap/contracts";
import {
  createOverviewSnapshot,
  type OverviewAgentFacts,
  type OverviewProjectFacts,
  type OverviewScope,
  type OverviewSources,
  type OverviewThreadFacts,
  type OverviewUserFacts,
} from "./snapshot.ts";

export const NOW = 1_700_000_000_000;
export const OWNER = "owner-1";
export const MEMBER = "member-1";

export const session = (patch: Partial<ShellSession> & { id: string }): ShellSession => ({
  cwd: "/boxes/p/project",
  name: null,
  preview: null,
  status: "idle",
  needsInput: false,
  projectId: null,
  pinRank: null,
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  createdAt: NOW - 5000,
  updatedAt: NOW - 5000,
  ...patch,
});

export const task = (patch: Partial<TaskView> & { id: string }): TaskView => ({
  triggerId: null,
  triggerName: "",
  projectId: null,
  state: "running",
  reason: null,
  origin: "manual",
  title: "a task",
  detail: null,
  createdAt: NOW - 4000,
  startedAt: NOW - 3000,
  endedAt: null,
  sessionId: null,
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  agentId: null,
  target: "isolated",
  requestedBy: null,
  notBefore: null,
  note: null,
  waiting: null,
  ...patch,
});

export const item = (patch: Partial<InboxItem> & { id: string }): InboxItem => ({
  kind: "agent_approve",
  toHandle: true,
  taskId: null,
  sessionId: null,
  triggerName: "Approve a push",
  costUsd: null,
  createdAt: NOW - 1000,
  readAt: null,
  resolvedAt: null,
  resolution: null,
  agentId: null,
  refId: null,
  entryId: null,
  detail: null,
  ...patch,
});

type Phases = Record<string, "stopped" | "starting" | "running" | "paused" | "stopping">;

export interface World {
  agents?: Record<string, OverviewAgentFacts[]>;
  projects?: Record<string, OverviewProjectFacts[]>;
  sessions?: Record<string, ShellSession[]>;
  /** Agent threads by owner and session id: the real shell window never lists them. */
  threads?: Record<string, Record<string, OverviewThreadFacts>>;
  tasks?: Record<string, TaskView[]>;
  pending?: Record<string, InboxItem[]>;
  paused?: Record<string, string[]>;
  triggers?: Array<{
    ownerId: string;
    agentId: string | null;
    projectId: string | null;
    nextFireAt: number | null;
    name: string;
  }>;
  phases?: Phases;
  reserved?: Record<string, number>;
  users?: OverviewUserFacts[];
  memory?: { usedMb: number; maxMb: number };
  live?: Record<string, number>;
  spend?: {
    agents?: Record<string, number>;
    projects?: Record<string, number>;
    totalUsd?: number;
    subscription?: boolean;
    subscriptionAgents?: string[];
    subscriptionProjects?: string[];
  };
  roles?: Record<string, "owner" | "member">;
}

const keyOf = (box: BoxRef) => `${box.kind}:${box.id}`;

/** A browser owner: `users:read` and `pi:admin` both held. */
export const FULL_SCOPE: OverviewScope = { members: true, failures: true };

export function build(world: World = {}) {
  const spendCalls: Array<{ ownerId: string; apiOnly: boolean }> = [];
  const sources: OverviewSources = {
    roleOf: (userId) =>
      world.roles?.[userId] ?? (userId === OWNER ? "owner" : userId === MEMBER ? "member" : null),
    runtime: {
      memory: () => world.memory ?? { usedMb: 3072, maxMb: 10_240 },
      reservedMb: (box) => world.reserved?.[keyOf(box)] ?? 0,
      phase: (box) => world.phases?.[keyOf(box)] ?? "stopped",
    },
    workers: () => ({ used: 2, max: 6 }),
    dayStart: () => NOW - 3_600_000,
    spend: {
      todayByBox(ownerId, _from, apiOnly) {
        spendCalls.push({ ownerId, apiOnly });
        return {
          agents: new Map(Object.entries(world.spend?.agents ?? {})),
          projects: new Map(Object.entries(world.spend?.projects ?? {})),
          totalUsd: world.spend?.totalUsd ?? 0,
          subscription: world.spend?.subscription ?? false,
          subscriptionAgents: new Set(world.spend?.subscriptionAgents ?? []),
          subscriptionProjects: new Set(world.spend?.subscriptionProjects ?? []),
        };
      },
      liveRuns: () => new Map(Object.entries(world.live ?? {})),
    },
    agents: (ownerId) => world.agents?.[ownerId] ?? [],
    projects: (ownerId) => world.projects?.[ownerId] ?? [],
    sessions: (ownerId) => world.sessions?.[ownerId] ?? [],
    thread: (ownerId, sessionId) => world.threads?.[ownerId]?.[sessionId] ?? null,
    tasks: (ownerId) => world.tasks?.[ownerId] ?? [],
    pending: (ownerId) => world.pending?.[ownerId] ?? [],
    pausedProjects: (ownerId) => world.paused?.[ownerId] ?? [],
    triggers: (ownerId) => (world.triggers ?? []).filter((trigger) => trigger.ownerId === ownerId),
    members: () => (world.users ?? []).filter((user) => user.role === "member"),
    user: (userId) => (world.users ?? []).find((user) => user.id === userId) ?? null,
    failures: () => 3,
  };
  const build = createOverviewSnapshot(sources);
  const snapshot = (viewerId: string, vmUsable: boolean, scope: OverviewScope = FULL_SCOPE) =>
    build(viewerId, vmUsable, scope);
  return { snapshot, spendCalls };
}

export const agent = (
  id: string,
  rail: AgentRailState | null,
  patch: Partial<OverviewAgentFacts> = {},
): OverviewAgentFacts => ({
  id,
  name: `agent ${id}`,
  threadSessionId: `thread-${id}`,
  memoryMb: 1024,
  alwaysOn: false,
  rail,
  ...patch,
});

export const project = (
  id: string,
  kind: "box" | "host",
  patch: Partial<OverviewProjectFacts> = {},
): OverviewProjectFacts => ({
  id,
  name: `project ${id}`,
  kind,
  memoryMb: kind === "box" ? 1024 : 0,
  alwaysOn: false,
  ...patch,
});

export const boxOf = (boxes: OverviewBox[], id: string): OverviewBox => {
  const found = boxes.find((one) => one.ref.id === id);
  if (!found) throw new Error(`no box ${id}`);
  return found;
};

export function member(patch: Partial<OverviewUserFacts> & { id: string }): OverviewUserFacts {
  return {
    username: patch.id,
    role: "member",
    disabled: false,
    budgetUsd: 5,
    spentTodayUsd: 0,
    boxes: [],
    ...patch,
  };
}
