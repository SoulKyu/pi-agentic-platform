import { PapError, type SandboxSpec, type ThinkingLevel, type VaultUpdateRecord } from "@pap/contracts";
import { agentHomePath } from "./agent-home.ts";
import { automationCaller, type TaskSessionPolicy } from "./automation-port.ts";
import type { AgentSurface } from "./agent-surface.ts";
import type { LiveSession } from "./live-session.ts";
import type { MarksStore } from "./marks-store.ts";
import type { ReleaseResult } from "./restart-folder.ts";
import type { SessionsService, SessionsServiceDeps } from "./service-types.ts";
import { type SessionRow, storedPresetOf } from "./store.ts";

/** What the agents module (Task 9) and the runner (Task 10) may do to the sessions of agents, and nothing more (M11R50). */
export interface SessionsAgentPort {
  /**
   * `not_found` (no such agent of the owner), `capacity` (the cap, the memory floor, or the owner's last worker: M10R154),
   * `disk_low`, then the launch gate's codes (`agent_paused`, `invalid_cwd`, `sandbox_unavailable`) and `worker_failed`.
   * The binding is stored with the row, in one transaction with the task policy when there is one.
   */
  createAgentSession(input: {
    ownerId: string;
    agentId: string;
    role: "thread" | "task";
    /** An isolated task's policy (M10R31). */
    task?: TaskSessionPolicy;
    /** An isolated task's scratch folder, its working folder (owner m17). */
    scratch?: string;
  }): Promise<{ sessionId: string }>;
  threadState(
    ownerId: string,
    sessionId: string,
  ): { running: boolean; needsInput: boolean; starting: boolean; archived: boolean } | null;
  /** The sandbox of an agent trigger's precheck (M11R68): `sandbox_unavailable` and the gate's other codes refuse it. */
  precheckSandbox(ownerId: string, agentId: string): Promise<SandboxSpec>;
  /** A networked precheck's own proxy socket (M11R243) and its release; `sandbox_unavailable` when none can be opened. */
  precheckEgress(ownerId: string, agentId: string): Promise<{ socket: string; release(): Promise<void> }>;
  /** The last assistant text of an agent's session, cut to `max` characters; null when there is none or it is not the owner's. */
  lastText(ownerId: string, sessionId: string, max: number, since?: number): Promise<string | null>;
  /** The folders the sessions of isolated agent tasks work in (M11R180: the sweep keeps these). */
  taskFolders(): ReadonlySet<string>;
  /** M9's `releaseIdle`: stops the worker when quiet, leaves it alone otherwise, `cold` when there is none. */
  releaseIdle(ownerId: string, sessionId: string): ReleaseResult;
  /**
   * M11R47: a model or thinking change reaches a worker that is up now. `cold`: no worker, the next start reads the
   * profile. `busy`: the model cannot change under a run; the profile applies at the next start.
   */
  applyLive(input: {
    ownerId: string;
    sessionId: string;
    model?: { provider: string; modelId: string };
    thinking?: ThinkingLevel;
  }): Promise<"applied" | "cold" | "busy">;
  /**
   * Tells the live workers of the agent (thread and running tasks, sandbox on; never a child, RT-07) that its vault
   * changed. A worker that cannot be told is stopped: its next start reads the current vault. Returns how many were told.
   * With `sessionId`, only that session's worker is told (a one-use value goes to the asking session alone).
   */
  sendToAgent(ownerId: string, agentId: string, record: VaultUpdateRecord, sessionId?: string): number;
  /** The tools the session's worker last said are active (its loadout), and whether the list was cut; null when no worker is up or it has said none. */
  activeTools(ownerId: string, sessionId: string): { tools: readonly string[]; truncated: boolean } | null;
  /** The session's worker started with the sandbox on (its start-time profile requires it); false for any other, or not the owner's. */
  sandboxed(ownerId: string, sessionId: string): boolean;
  /** The session is the owner's and runs in a VM: no vault, no one-use value, no secret request (R11). */
  runsInVm(ownerId: string, sessionId: string): boolean;
}

export interface AgentPortContext {
  readonly deps: SessionsServiceDeps;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly starting: ReadonlySet<LiveSession>;
  readonly reopening: ReadonlyMap<string, Promise<LiveSession>>;
  readonly agent: AgentSurface;
  readonly marks: MarksStore;
  /** Ids whose launch leaves the owner's last worker free; `launch` consumes the id after the gate. */
  readonly keepFreeFor: Set<string>;
  /** The owner's last worker stays free (M10R154). */
  keepOneFree(): void;
  launch(row: SessionRow, isNew: boolean): Promise<LiveSession>;
  releaseIdle(ownerId: string, sessionId: string): ReleaseResult;
  /** The service itself, read when a call comes in: the port is built before the object it belongs to. */
  readonly models: () => Pick<SessionsService, "setModel" | "setThinking">;
  /** The transcript reads' last assistant text. */
  readonly lastText: (sessionId: string, max: number, since?: number) => Promise<string | null>;
}

export function createAgentPort(ctx: AgentPortContext): SessionsAgentPort {
  const { deps, live, reopening } = ctx;
  return {
    async createAgentSession({ ownerId, agentId, role, task, scratch }) {
      const profile = ctx.agent.profileOf(ownerId, agentId);
      if (profile === null) throw new PapError("not_found");
      if (
        role === "task"
          ? !task || !scratch || task.tools.length === 0
          : task !== undefined || scratch !== undefined
      )
        throw new PapError("bad_request");
      // The folder is only named here: the gate opens it, without following a link, at every launch (M11R51).
      const cwd = role === "task" && scratch ? scratch : agentHomePath(deps.worker.papHome, agentId);
      deps.admission?.task();
      // Checked again inside `launch`, after the gate; here a full pool answers before the gate opens anything.
      ctx.keepOneFree();
      const now = deps.clock.now();
      const preset = role === "task" && task ? task.preset : storedPresetOf(profile.input.preset);
      const row: SessionRow = {
        id: deps.newId(),
        piPath: null,
        piSessionId: null,
        cwd,
        ownerId,
        name: null,
        createdAt: now,
        updatedAt: now,
        ...(preset ? { toolPreset: preset } : {}),
        ...(task ? { task } : {}),
        agentId,
        agentRole: role,
      };
      ctx.keepFreeFor.add(row.id);
      try {
        await ctx.launch(row, true);
      } finally {
        ctx.keepFreeFor.delete(row.id);
      }
      return { sessionId: row.id };
    },
    taskFolders: () => deps.store.taskFolders(),
    precheckSandbox: (ownerId, agentId) => ctx.agent.precheckSandbox(ownerId, agentId),
    precheckEgress: (ownerId, agentId) => ctx.agent.precheckEgress(ownerId, agentId),
    async lastText(ownerId, sessionId, max, since) {
      const row = deps.store.get(sessionId);
      if (!row || row.ownerId !== ownerId || row.agentId === undefined) return null;
      return ctx.lastText(sessionId, max, since);
    },
    threadState(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      if (!row || row.ownerId !== ownerId || row.agentId === undefined) return null;
      const session = live.get(sessionId);
      return {
        running: session?.status() === "running",
        needsInput: (session?.dialogs().length ?? 0) > 0,
        starting: reopening.has(sessionId) || session?.status() === "starting",
        archived: ctx.marks.row(sessionId)?.marks.archivedAt != null,
      };
    },
    releaseIdle(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      if (!row || row.ownerId !== ownerId) throw new PapError("not_found");
      return ctx.releaseIdle(ownerId, sessionId);
    },
    async applyLive({ ownerId, sessionId, model, thinking }) {
      const row = deps.store.get(sessionId);
      if (!row || row.ownerId !== ownerId || row.agentId === undefined) throw new PapError("not_found");
      const session = live.get(sessionId);
      if (!session || session.stopping()) return "cold";
      const caller = automationCaller(ownerId);
      try {
        if (model) await ctx.models().setModel({ sessionId, ...model }, caller);
        if (thinking) await ctx.models().setThinking({ sessionId, level: thinking }, caller);
      } catch (error) {
        if (error instanceof PapError && error.code === "session_busy") return "busy";
        throw error;
      }
      return "applied";
    },
    activeTools(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      if (row?.ownerId !== ownerId || row.agentId === undefined) return null;
      const loadout = live.get(sessionId)?.loadout();
      return loadout ? { tools: loadout.tools, truncated: loadout.toolsTruncated } : null;
    },
    sandboxed(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      return row?.ownerId === ownerId && row.agentId !== undefined && ctx.agent.sandboxed(sessionId);
    },
    runsInVm(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      return row?.ownerId === ownerId && ctx.agent.vmLayoutOf(row) !== null;
    },
    sendToAgent(ownerId, agentId, record, sessionId) {
      let told = 0;
      for (const [id, session] of [...live]) {
        if (sessionId !== undefined && id !== sessionId) continue;
        const row = deps.store.get(id);
        const mine = row?.ownerId === ownerId && row.agentId === agentId;
        if (!mine || (row.agentRole !== "thread" && row.agentRole !== "task") || !ctx.agent.sandboxed(id))
          continue;
        // R11 (RT-11): a VM session never gets a vault value or a one-use value, whatever its profile's switch says.
        if (ctx.agent.vmLayoutOf(row) !== null) continue;
        if (session.status() === "cold" || session.stopping()) continue;
        // Every record carries the session's full once list (W5-R37); a targeted send was built for that session already.
        const own = sessionId === undefined ? { ...record, once: [...ctx.agent.onceOf(id)] } : record;
        if (session.send(own)) told += 1;
        else
          session
            .stop()
            .catch((error: unknown) =>
              deps.logger.warn("vault_update_stop_failed", { sessionId: id, err: error }),
            );
      }
      return told;
    },
  };
}
