import {
  type ApprovalMode,
  type Caller,
  type DialogResponse,
  opsFor,
  PapError,
  type PlatformOp,
  type ToolPreset,
  VaultUpdateRecord,
  type VmLayout,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PlatformPort } from "../platform/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import {
  type AgentGateDeps,
  type AgentLaunch,
  agentGate,
  type AgentProfile,
  type SessionsAgentDeps,
} from "./agent-gate.ts";
import { type AgentRuleParts, createAgentRules, type OwnerLists } from "./agent-rules.ts";
import { childModeOf } from "./child-port.ts";
import { narrowPreset } from "./preset-clamp.ts";
import { type ProjectLaunch, projectGate } from "./project-gate.ts";
import { type ApprovedCalls, createApprovedCalls, isPlatformTool } from "./approved-calls.ts";
import { AUTOMATION_CREDENTIAL } from "./automation-port.ts";
import type { ApprovedAnswer } from "./dialogs.ts";
import { createHostGrants, type HostGrants } from "./host-grants.ts";
import { allowProjectHost } from "./project-host.ts";
import type { LiveSession } from "./live-session.ts";
import { type SessionKind, sessionKind } from "./session-kind.ts";
import type { SessionRow, SessionsStore } from "./store.ts";
import type { VmLaunch } from "./vm-launch.ts";

const TOKEN_ANSWERS: ReadonlySet<string> = new Set(["deny", "once"]);

/** What later modules hand the sessions module once they exist (before any worker starts): `setAgentPorts` fills it. */
export interface SessionsAgentPorts {
  /** The platform dispatcher: where a worker's `platform_call` goes, and which ops a starting worker gets. */
  platform?: PlatformPort | undefined;
  /** The row's folder is inside one of the owner's lane worktrees (the lanes module's records). */
  inLane?: ((ownerId: string, cwd: string) => boolean) | undefined;
  /** The agents registry, the vault and the VM predicates: the launch gate of every agent session (M11R53). */
  agents?: SessionsAgentDeps | undefined;
}

export interface AgentSurface {
  setAgentPorts(ports: SessionsAgentPorts): void;
  /** The daemon's record of who a session is, read now; null when it does not exist. `autonomous`: owner a6 (ii), M11R220. */
  kindOf(sessionId: string): (SessionKind & { readonly autonomous: boolean }) | null;
  /** The same for a row not stored yet (a new session's launch): memory trust is decided from it (M11R142). */
  kindOfRow(row: SessionRow): SessionKind;
  /**
   * After the worker joined the live sessions: the `vault_update` that brings it level with the vault as it is now, or
   * null when `init` already carried that vault. A change made while the worker booted reaches no `live` session (M11R86).
   */
  vaultDrift(row: SessionRow, launch: AgentLaunch): VaultUpdateRecord | null;
  /** The worker of this session reported that it used the one-use value of this name. */
  secretUsed(sessionId: string, id: string): void;
  /** The one-use values waiting for the session now, as its worker must hold them. */
  onceOf(sessionId: string): ReadonlyArray<{ id: string; name: string; value: string; expiresAt: number }>;
  /** The ops a worker for this row registers at its start: its type's, whose handler is there and whose switch is on. */
  platformOps(row: SessionRow): PlatformOp[];
  platform(): PlatformPort | undefined;
  /** The agent of an owner as the registry reads it now; null when there is none, or its profile does not parse. */
  profileOf(ownerId: string, agentId: string): AgentProfile | null;
  /** A worker started with this profile and keeps it until it exits (M11R47, W5-R26). */
  started(sessionId: string, profile: AgentProfile): void;
  ended(sessionId: string): void;
  /** The session has a live worker started by the gate (every agent session is a VM one): the workers a vault reaches. */
  sandboxed(sessionId: string): boolean;
  /** R38: the worker's shell is pap's bwrap in the VM. */
  shellSandboxed(sessionId: string): boolean;
  /** Owner a5 (M11R213): an agent thread whose sandbox is on in the registry now and, while a worker runs, at that worker's start. */
  sandboxedThread(ownerId: string, sessionId: string): boolean;
  /** The mode of the profile in force for an agent thread (the start-time one while it runs); null for any other session. */
  modeOf(ownerId: string, sessionId: string): ApprovalMode | null;
  /** The preset an owner's choice gives an agent thread: never wider than the start-time profile's (W5-R26, W5-R28). */
  clampPreset(row: SessionRow, preset: ToolPreset): ToolPreset;
  /** The preset a thread starts with: the profile's, narrowed by the owner's stored choice when there is one (W5-R28). */
  presetFor(ownerPreset: ToolPreset | undefined, profilePreset: ToolPreset): ToolPreset;
  /** The gate of a launch (M11R53): null for a session without an agent; a throw refuses the start. */
  gate(row: SessionRow): Promise<AgentLaunch> | null;
  /** The gate of a launch in a project's box (task A3): null for a row that is not in one; a throw (`not_found`) refuses the start. */
  projectGate(row: SessionRow): ProjectLaunch | null;
  /**
   * ADR 0080 for a box: the launch with the bridge's Claude Code environment (`IS_SANDBOX`, `CLAUDE_CONFIG_DIR` under the box's
   * home) when the owner's token is set and the bridge is in the owner's packages: the agents' own rule (`claudeEnvOf`).
   */
  projectEnv(launch: ProjectLaunch): Promise<ProjectLaunch>;
  /** The row runs in a VM (R15, R37): its layout, else null. */
  vmLayoutOf(row: SessionRow): VmLayout | null;
  /** The agent's part of the session's rules (M11R52); nothing for a session without an agent. */
  rulesOf(row: SessionRow, owner: OwnerLists): AgentRuleParts;
  readonly approvedCalls: ApprovedCalls;
  /** The hosts the owner allowed for the rest of an agent thread (owner a2): daemon memory, dropped when the thread is archived. */
  readonly hostGrants: HostGrants;
  /** The project box a session with no agent runs in, with its list now; null for any other session (task A7). */
  projectBoxOfSession(
    sessionId: string,
  ): { readonly projectId: string; readonly hosts: readonly string[] } | null;
  /**
   * Before an answer reaches the worker: only the owner's browser answers the card of a platform tool, and only a browser
   * session answers `host`, on an agent thread's `network_request` card (M11R209).
   */
  guardAnswer(
    session: Pick<LiveSession, "dialogs">,
    dialogId: string,
    caller: Caller,
    response: DialogResponse,
    sessionId: string,
  ): void;
  /** After an answer: notes the owner's Allow once on a platform tool's card, or its host grant (never a token's). */
  noted(sessionId: string, approved: ApprovedAnswer | null, caller: Caller): void;
}

export function createAgentSurface(deps: {
  readonly store: Pick<SessionsStore, "get" | "readOnly">;
  readonly policy: Pick<PolicyPort, "sessionPolicy">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly worker: { readonly papHome: string; readonly agentDir: string };
  /** Present when the VM stack is composed: the agents ports must then carry the VM predicate (T8a). */
  readonly vmLaunch?: VmLaunch | undefined;
}): AgentSurface {
  const ports: SessionsAgentPorts = {};
  const profileOf = (ownerId: string, agentId: string): AgentProfile | null =>
    ports.agents?.profileOf(ownerId, agentId) ?? null;
  // The profile each running agent worker started with, by session id: bounded by the workers that exist (W5-R26).
  const startTime = new Map<string, AgentProfile>();
  const profileFor = (ownerId: string, agentId: string, sessionId: string): AgentProfile | null =>
    startTime.get(sessionId) ?? profileOf(ownerId, agentId);
  const vmLayoutOf = (row: SessionRow): VmLayout | null => ports.agents?.vmLayoutOf?.(row) ?? null;
  const vmMode = deps.vmLaunch !== undefined;
  const projectRefOf = (row: SessionRow) => {
    const id = ports.agents?.boxes?.projectOf(row) ?? null;
    const box = id === null ? null : (ports.agents?.boxes?.box(id) ?? null);
    return id === null || box === null ? null : { projectId: id, box };
  };
  const projectBoxOf = (row: SessionRow) => projectRefOf(row)?.box ?? null;
  const hostGrants = createHostGrants(deps.logger);
  const agentRules = createAgentRules({
    papHome: deps.worker.papHome,
    profileOf: profileFor,
    hostGrants: hostGrants.of,
    logger: deps.logger,
    vmLayoutOf,
    projectBoxOf,
  });
  const gateDeps = (agents: SessionsAgentDeps): AgentGateDeps => ({
    ...agents,
    papHome: deps.worker.papHome,
    agentDir: deps.worker.agentDir,
    logger: deps.logger,
  });
  const approvedCalls = createApprovedCalls(deps);
  const kindDeps = {
    policy: deps.policy,
    // A box folder is no lane's: the lane index would realpath a path that is the box's, not the host's.
    inLane: (ownerId: string, cwd: string) =>
      ports.agents?.boxes?.projectOf({ ownerId, cwd }) != null
        ? false
        : (ports.inLane?.(ownerId, cwd) ?? false),
  };
  /** Owner a6 (ii), M11R220: on in the start-time profile and in the registry; no worker, no autonomy. */
  const autonomousOf = (row: SessionRow): boolean =>
    row.agentRole === "thread" &&
    row.agentId !== undefined &&
    startTime.get(row.id)?.input.trustedAutonomy === true &&
    profileOf(row.ownerId, row.agentId)?.input.trustedAutonomy === true;
  /** Only the owner's browser (never a token, never the automation credential) answers `host`, on a thread's own card. */
  const mayGrantHost = (sessionId: string, tool: string | undefined, caller: Caller): boolean => {
    if (caller.kind !== "session" || caller.credentialId === AUTOMATION_CREDENTIAL) return false;
    const row = deps.store.get(sessionId);
    return (
      tool === "network_request" &&
      row !== undefined &&
      (sessionKind(row, kindDeps).type === "agent-thread" || projectRefOf(row) !== null)
    );
  };
  return {
    hostGrants,
    projectBoxOfSession(sessionId) {
      const row = deps.store.get(sessionId);
      const ref = row === undefined ? null : projectRefOf(row);
      return ref === null ? null : { projectId: ref.projectId, hosts: ref.box.hosts };
    },
    setAgentPorts(next) {
      // Fail closed at the hand-over: `agents` replaces the whole object, and an agent row would run on the host without these.
      const { agents } = next;
      if (vmMode && agents && !agents.vmLayoutOf) throw new Error("the agents ports lack vmLayoutOf");
      Object.assign(ports, next);
    },
    kindOfRow: (row) => sessionKind(row, kindDeps),
    kindOf(sessionId) {
      const row = deps.store.get(sessionId);
      return row ? { ...sessionKind(row, kindDeps), autonomous: autonomousOf(row) } : null;
    },
    platformOps(row) {
      const platform = ports.platform;
      // A read-only database runs no op: no dead tools (W5-R16 siblings, M10R150).
      if (!platform || deps.store.readOnly) return [];
      try {
        const { type } = sessionKind(row, kindDeps);
        const inBox = projectRefOf(row) !== null;
        // `network.request` is open to the sessions of a project box and to agent threads, never to a host row.
        return opsFor(type).filter(
          (op) =>
            platform.available(op, row.ownerId) &&
            (op !== "network.request" || type === "agent-thread" || inBox),
        );
      } catch (error) {
        // Fail closed: a worker whose type cannot be read starts without platform tools.
        deps.logger.warn("platform_ops_failed", { sessionId: row.id, err: error });
        return [];
      }
    },
    platform: () => ports.platform,
    vaultDrift(row, launch) {
      if (!launch.vault || row.agentId === undefined) return null;
      const now = ports.agents?.vaultOf?.(row.ownerId, row.agentId) ?? {};
      const sent = launch.vault;
      const same =
        Object.keys(now).length === Object.keys(sent).length &&
        Object.entries(now).every(([name, value]) => sent[name] === value);
      // The once list is authoritative (W5-R37): when it differs from what init carried, the whole current list is sent.
      const onceNow = ports.agents?.onceOf?.(row.id) ?? [];
      const sentOnce = launch.once ?? [];
      const sameOnce =
        onceNow.length === sentOnce.length &&
        onceNow.every((entry, index) => {
          const kept = sentOnce[index];
          return (
            kept?.id === entry.id &&
            kept.name === entry.name &&
            kept.value === entry.value &&
            kept.expiresAt === entry.expiresAt
          );
        });
      if (same && sameOnce) return null;
      // Parsed as the secrets module's `push` parses it: a vault the contract refuses is not sent (the worker would drop it).
      const record = VaultUpdateRecord.safeParse({ type: "vault_update", vault: now, once: onceNow });
      if (record.success) return record.data;
      deps.logger.warn("vault_update_invalid", { agentId: row.agentId });
      return null;
    },
    onceOf: (sessionId) => ports.agents?.onceOf?.(sessionId) ?? [],
    secretUsed: (sessionId, id) => void ports.agents?.onceUsed?.(sessionId, id),
    profileOf,
    started: (sessionId, profile) => void startTime.set(sessionId, profile),
    ended: (sessionId) => void startTime.delete(sessionId),
    // Every agent session runs in a VM with pap's own shell, whatever its profile's retired sandbox switch says (ADR 0081).
    sandboxed: (sessionId) => startTime.has(sessionId),
    shellSandboxed: (sessionId) => startTime.has(sessionId),
    sandboxedThread(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      if (row?.ownerId !== ownerId || row.agentRole !== "thread" || row.agentId === undefined) return false;
      // RT-10, R15: a VM thread's shell is always sandboxed, whatever its profile's host-sandbox switch says.
      if (vmLayoutOf(row) !== null) return true;
      const started = startTime.get(sessionId);
      if (started !== undefined && started.input.sandbox.required !== true) return false;
      return profileOf(ownerId, row.agentId)?.input.sandbox.required === true;
    },
    modeOf(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      if ((row?.agentRole !== "thread" && row?.agentRole !== "child") || row.agentId === undefined)
        return null;
      // A profile that does not read composes read-only rules (M11R52): the view says so.
      const mode = profileFor(ownerId, row.agentId, sessionId)?.input.mode ?? "read-only";
      return row.agentRole === "child" ? childModeOf(mode) : mode;
    },
    clampPreset(row, preset) {
      if ((row.agentRole !== "thread" && row.agentRole !== "child") || row.agentId === undefined)
        return preset;
      const allowed = profileFor(row.ownerId, row.agentId, row.id)?.input.preset;
      return allowed === undefined ? preset : narrowPreset(preset, allowed);
    },
    presetFor: (ownerPreset, profilePreset) =>
      ownerPreset === undefined ? profilePreset : narrowPreset(ownerPreset, profilePreset),
    gate(row) {
      if (row.agentId === undefined) return null;
      // No registry bound: the agent cannot be resolved, so the session does not start.
      if (!ports.agents) return Promise.reject(new PapError("not_found"));
      return agentGate(row, gateDeps(ports.agents));
    },
    projectGate: (row) =>
      ports.agents?.boxes === undefined
        ? null
        : projectGate(row, { boxes: ports.agents.boxes, vmLayoutOf, papHome: deps.worker.papHome }),
    async projectEnv(launch) {
      const agents = ports.agents;
      if (!agents?.boxes?.claudeTokenSet() || !agents.claudeEnvOf) return launch;
      const claudeEnv = await agents.claudeEnvOf({ model: null, packages: null } as never, {
        vm: true,
        home: launch.home,
      });
      return Object.keys(claudeEnv).length > 0 ? { ...launch, claudeEnv } : launch;
    },
    vmLayoutOf,
    rulesOf: (row, owner) => agentRules(row, owner),
    approvedCalls,
    guardAnswer(session, dialogId, caller, response, sessionId) {
      // A token answers deny or once (Q7): a rule that outlives the token is a browser session's to make.
      if (caller.kind === "token" && "answer" in response && !TOKEN_ANSWERS.has(response.answer))
        throw new PapError("forbidden");
      const dialog = session.dialogs().find((open) => open.id === dialogId);
      // A card that does not offer `host` is left to the answer path (bad_request); one that offers it is the owner's alone.
      if ("answer" in response && response.answer === "host" && dialog?.answers?.includes("host")) {
        if (!mayGrantHost(sessionId, dialog.tool, caller)) throw new PapError("forbidden");
        return;
      }
      if (caller.kind === "session") return;
      if (dialog?.method === "approval" && dialog.tool !== undefined && isPlatformTool(dialog.tool))
        throw new PapError("forbidden");
    },
    noted(sessionId, approved, caller) {
      const { grant } = approved ?? {};
      if (approved?.answer === "host") {
        // The host is the one the worker's card named, kept beside the dialog; the client's frame is never read.
        if (grant?.host === undefined || !mayGrantHost(sessionId, grant.tool, caller)) return;
        const row = deps.store.get(sessionId);
        const ref = row === undefined ? null : projectRefOf(row);
        // A box session's host joins its project's list (kept and audited); an agent thread's lasts until the thread resets.
        const boxes = ports.agents?.boxes;
        if (
          ref === null ||
          (boxes !== undefined &&
            allowProjectHost({ boxes, logger: deps.logger }, ref.projectId, grant.host, caller))
        )
          hostGrants.note(sessionId, grant.host);
        return;
      }
      if (
        caller.kind !== "session" ||
        caller.credentialId === AUTOMATION_CREDENTIAL ||
        approved?.answer !== "once" ||
        !grant
      )
        return;
      if (grant.toolCallId !== undefined && isPlatformTool(grant.tool))
        approvedCalls.note(sessionId, grant.toolCallId, grant.tool);
    },
  };
}
