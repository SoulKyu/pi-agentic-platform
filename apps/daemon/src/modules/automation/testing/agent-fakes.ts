import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PapError, type SandboxSpec } from "@pap/contracts";
import { vi } from "vitest";
import type { Db } from "../../../kernel/db/database.ts";
import type { AgentPorts } from "../index.ts";

export const AGENT = "atlas-1a2b";
export const TASK = "0b1c2d3e-0001-4000-8000-000000000001";

export interface FakeAgent {
  ownerId: string;
  name: string;
  paused: boolean;
  quarantinedAt: number | null;
  threadSessionId: string | null;
  /** The profile's budget (M11R74); none: no profile read (the default: no budget). */
  input: { budget: { usdPerDay: number | null; tokensPerDay: number | null } } | null;
}

/**
 * The agents registry, the agent sessions and the card writer as the automation module sees them (`AgentPorts`), over
 * folders in `root`: the scratch folders are real folders, so a test can see what the runner made and removed.
 */
export function fakeAgentPorts(root: string, realSpend?: AgentPorts["spend"]) {
  const agents = new Map<string, FakeAgent>();
  const cards: Array<{ ownerId: string; agentId: string; taskId: string; data: Record<string, unknown> }> =
    [];
  const removed: string[] = [];
  let sessions = 0;
  const homeOf = (agentId: string): string => join(root, "agents", agentId);
  const scratchPathOf = (agentId: string, taskId: string): string =>
    join(root, "agents", ".runs", agentId, taskId);
  const owned = (ownerId: string, agentId: string): FakeAgent | null => {
    const agent = agents.get(agentId);
    return agent && agent.ownerId === ownerId ? agent : null;
  };
  const createAgentSession = vi.fn(async (input: { ownerId: string; agentId: string }) => {
    if (!owned(input.ownerId, input.agentId)) throw new PapError("not_found");
    sessions += 1;
    return { sessionId: `agent-s${sessions}` };
  });
  const precheckSandbox = vi.fn(async (): Promise<SandboxSpec> => ({
    bwrap: "/usr/bin/bwrap",
    view: "system",
    home: homeOf(AGENT),
    writable: null,
    hide: ["/var/log"],
    egress: null,
    network: false,
  }));
  /** A networked precheck's own proxy socket (M11R243); the default spec is network-off, so this is only called when a test asks. */
  const precheckEgress = vi.fn(async () => ({
    socket: "/run/pap-fake/0/0.s",
    release: async (): Promise<void> => {},
  }));
  const lastText = vi.fn(async (): Promise<string | null> => "The run's last words.");
  const taskFolders = vi.fn((): ReadonlySet<string> => new Set<string>());
  /** The thread's state as `threadState` reports it, by session; an unlisted session is a warm idle thread. */
  const threads = new Map<
    string,
    { running: boolean; needsInput: boolean; starting: boolean; archived: boolean }
  >();
  const threadState = vi.fn((_ownerId: string, sessionId: string) => threads.get(sessionId) ?? idle());
  const open = vi.fn(async (ownerId: string, agentId: string): Promise<{ sessionId: string }> => {
    const agent = owned(ownerId, agentId);
    if (!agent) throw new PapError("not_found");
    agent.threadSessionId ??= `thread-${agentId}`;
    return { sessionId: agent.threadSessionId };
  });
  const spent = new Map<string, { usd: number; tokens: number }>();
  const spend: AgentPorts["spend"] = realSpend ?? {
    agentSpentToday: vi.fn(
      (_ownerId: string, agentId: string) => spent.get(agentId) ?? { usd: 0, tokens: 0 },
    ),
    taskRuns: vi.fn((): { usd: number; billing: "api" | "subscription" | "unknown" } => ({
      usd: 0,
      billing: "unknown",
    })),
  };
  const runCards: Array<{ agentId: string; taskId: string; kind: string; data: Record<string, unknown> }> =
    [];
  const runCard = vi.fn(
    (
      _ownerId: string,
      agentId: string,
      taskId: string,
      kind: "schedule" | "task",
      data: Record<string, unknown>,
    ) => {
      runCards.push({ agentId, taskId, kind, data });
      return runCards.length;
    },
  );
  const runCardEnded = vi.fn(
    (
      _ownerId: string,
      agentId: string,
      taskId: string,
      patch: Record<string, unknown>,
      only?: { whileRunning: true },
    ) => {
      const card = runCards.find((entry) => entry.agentId === agentId && entry.taskId === taskId);
      if (!card || (only && card.data.state !== "running")) return false;
      card.data = { ...card.data, ...patch };
      return true;
    },
  );
  const isolated = vi.fn(
    (ownerId: string, agentId: string, taskId: string, data: Record<string, unknown>) => {
      cards.push({ ownerId, agentId, taskId, data });
      return true;
    },
  );
  const reminders: Array<{ agentId: string; taskId: string; card: { note: string; setAt: number } }> = [];
  const reminder = vi.fn(
    (_ownerId: string, agentId: string, taskId: string, card: { note: string; setAt: number }) => {
      reminders.push({ agentId, taskId, card });
      return true;
    },
  );
  /** The results of delegated tasks, as the agents module is told them (M11R79). */
  const back = vi.fn<AgentPorts["delegations"]["back"]>();
  /** The delegation request's card in the target's thread (M11R71): written when it starts, moved when it ends. */
  const requestCards: Array<{ agentId: string; taskId: string; data: Record<string, unknown> }> = [];
  const delegation = vi.fn(
    (_ownerId: string, agentId: string, taskId: string, data: Record<string, unknown>) => {
      requestCards.push({ agentId, taskId, data });
      return true;
    },
  );
  const delegationEnded = vi.fn(
    (_ownerId: string, agentId: string, taskId: string, state: string, only?: { whileRunning: true }) => {
      const card = requestCards.find((entry) => entry.agentId === agentId && entry.taskId === taskId);
      if (!card || (only && card.data.state !== "running")) return false;
      card.data = { ...card.data, state };
      return true;
    },
  );
  const ports: AgentPorts = {
    registry: {
      get: (ownerId, agentId) => owned(ownerId, agentId),
      homeOf(ownerId, agentId) {
        if (!owned(ownerId, agentId)) throw new PapError("not_found");
        return homeOf(agentId);
      },
      openScratch(ownerId, agentId, taskId) {
        if (!owned(ownerId, agentId)) throw new PapError("not_found");
        const path = scratchPathOf(agentId, taskId);
        const reused = existsSync(path);
        if (!reused) mkdirSync(path, { recursive: true, mode: 0o700 });
        return { path, reused };
      },
      scratchPathOf: (_ownerId, agentId, taskId) => scratchPathOf(agentId, taskId),
      sweepScratch(keep, limit) {
        const runs = join(root, "agents", ".runs");
        let removed = 0;
        if (!existsSync(runs)) return 0;
        for (const agentId of readdirSync(runs))
          for (const taskId of readdirSync(join(runs, agentId))) {
            const path = join(runs, agentId, taskId);
            if (removed >= limit || keep(agentId, taskId, path)) continue;
            rmSync(path, { recursive: true, force: true });
            removed += 1;
          }
        return removed;
      },
      removeScratch(_ownerId, agentId, taskId) {
        removed.push(`${agentId}/${taskId}`);
        rmSync(scratchPathOf(agentId, taskId), { recursive: true, force: true });
      },
    },
    sessions: { createAgentSession, precheckSandbox, precheckEgress, lastText, taskFolders, threadState },
    threads: { open },
    events: { isolated, runCard, runCardEnded, reminder, delegation, delegationEnded },
    delegations: { back },
    spend,
  };
  return {
    ports,
    agents,
    cards,
    removed,
    createAgentSession,
    precheckSandbox,
    precheckEgress,
    lastText,
    taskFolders,
    isolated,
    runCard,
    runCards,
    runCardEnded,
    reminder,
    reminders,
    delegation,
    delegationEnded,
    requestCards,
    back,
    threads,
    threadState,
    open,
    spend,
    /** What `agentSpentToday` says of the agent (unless the runs table is read instead). */
    spent,
    add(agentId = AGENT, ownerId = "u1", over: Partial<FakeAgent> = {}): void {
      agents.set(agentId, {
        ownerId,
        name: agentId === AGENT ? "Atlas" : agentId,
        paused: false,
        quarantinedAt: null,
        threadSessionId: null,
        input: null,
        ...over,
      });
    },
    homeOf,
    scratchPathOf,
    scratchExists(agentId: string, taskId: string): boolean {
      try {
        readdirSync(scratchPathOf(agentId, taskId));
        return true;
      } catch {
        return false;
      }
    },
  };
}
const idle = () => ({ running: false, needsInput: false, starting: false, archived: false });
export type FakeAgentPorts = ReturnType<typeof fakeAgentPorts>;

/** An agent trigger row the way `triggers.create` stores it, for tests that bring their own agent ports. */
export function insertAgentTrigger(
  db: Db,
  home: string,
  over: {
    id?: string;
    ownerId?: string;
    agentId?: string;
    target?: "isolated" | "thread";
    source?: { type: string } & Record<string, unknown>;
    precheck?: string | null;
  } = {},
): string {
  const id = over.id ?? "trg-agent-1";
  const agentId = over.agentId ?? AGENT;
  const source = over.source ?? { type: "manual" };
  const config = {
    name: "Agent trigger",
    source,
    execution: {
      agent: { agentId, target: over.target ?? "isolated" },
      tools: ["read", "grep"],
      mode: "supervised",
      precheck: over.precheck ?? null,
      env: [],
      retryOnInterrupt: false,
      maxRunMinutes: 20,
      maxRunUsd: null,
      dailyBudgetUsd: null,
    },
    prompt: "Look and report: {{payload}}",
  };
  db.run(
    `INSERT INTO triggers (id, owner_id, name, enabled, source_type, config, cwd, agent_id, revision, created_at, updated_at)
     VALUES ($id, $ownerId, 'Agent trigger', 1, $sourceType, $config, $cwd, $agentId, 1, 1, 1)`,
    {
      id,
      ownerId: over.ownerId ?? "u1",
      sourceType: source.type,
      config: JSON.stringify(config),
      cwd: home,
      agentId,
    },
  );
  return id;
}
