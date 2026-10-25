import { freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalMode } from "@pap/contracts";
import type { IsMember } from "../../kernel/box-path.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import { newId } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";
import { workerEnv } from "../../kernel/supervisor/env.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerScopes } from "../../kernel/supervisor/scope.ts";
import { spawnWorker } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { Hono } from "hono";
import type { AuditPort } from "../audit/index.ts";
import type { AttachmentsPort } from "../files/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { RunObserver } from "../runs/index.ts";
import type { AgentSurface } from "./agent-surface.ts";
import { mountExportRoute } from "./export-http.ts";
import { createExports } from "./exports.ts";
import { createLaneHooks, type LaneRunHooks } from "./lane-hooks.ts";
import { createSessionsLanePort, laneInfoOf, type SessionsLanePort } from "./lane-port.ts";
import { createHeldNotices } from "./held-notices.ts";
import type { SessionModelsDeps } from "./service-models.ts";
import { outsideToolResultsTaint } from "./outside-taint.ts";
import { createAdmission, DEFAULT_MIN_FREE_DISK_MB } from "./fork-quota.ts";
import { loadPiWriter, purgeForkTmp } from "./pi-writer.ts";
import { type SessionsRpc, sessionsRpc } from "./rpc.ts";
import type { SessionsScanPort } from "./scan-port.ts";
import { type ShellRpc, shellRpc } from "./shell-rpc.ts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import { createSessionsService } from "./service.ts";
import type { SessionsAgentPort } from "./agent-port.ts";
import type { SessionsChildPort } from "./child-port.ts";
import type { SessionsAutomationPort } from "./automation-port.ts";
import type { SessionsProjectPort } from "./project-port.ts";
import type { SessionsOwnerCascade } from "./owner-cascade.ts";
import { createSessionsStore } from "./store.ts";
import { loadTranscriptReader } from "./transcript.ts";
import type { VmLaunch } from "./vm-launch.ts";

export { boxCwdOf, gatedBoxCwdOf } from "./box-cwd.ts";
export { resolveSessionCwd } from "./cwd.ts";
export { createExports, type Exports } from "./exports.ts";
export type { SessionsAutomationPort } from "./automation-port.ts";
export type { SessionsProjectPort } from "./project-port.ts";
export type { SessionsOwnerCascade } from "./owner-cascade.ts";
export type { SessionsAgentPort } from "./agent-port.ts";
export type { ChildProfile, SessionsChildPort } from "./child-port.ts";
export type { Admission } from "./fork-quota.ts";
export { loadPiWriter, type PiWriter } from "./pi-writer.ts";
export type { SessionsScanPort } from "./scan-port.ts";
export type { SessionRow } from "./store.ts";
export type { SessionBoxes } from "./project-gate.ts";
export { createVmLaunch, type MirrorInputs, taskKeyOf, type VmLaunch } from "./vm-launch.ts";
export type { LaneRunHooks, LaneRunInfo } from "./lane-hooks.ts";
export type { SessionsLanePort } from "./lane-port.ts";

export const SESSIONS_MIGRATIONS: MigrationSource = {
  module: "sessions",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface SessionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  /** The policy module: the project's "always" rules, and where an "always" answer is saved (Task 14b). */
  readonly policy: PolicyPort;
  /** The projects module: each session is filed under the project of its folder (Task 7c). */
  readonly projects: ProjectsPort;
  /** The audit module: where a worker's audit entries are validated, scrubbed and stored (Task 10). */
  readonly audit: AuditPort;
  /** The files module's claims of pending uploads: what a prompt's attachments are checked against (M8R43). */
  readonly attachments: AttachmentsPort;
  readonly config: Pick<
    Config,
    | "home"
    | "piAgentDir"
    | "piHostEntry"
    | "piHostExecArgv"
    | "testProviderScript"
    | "maxWorkers"
    | "minFreeMemMb"
    | "workerIdleMs"
  > &
    Partial<Pick<Config, "minFreeDiskMb">>;
  /** The umask the daemon was started with, before it set its own 077: what the workers' tools run under (R114). */
  readonly workerUmask: number;
  readonly env: NodeJS.ProcessEnv;
  readonly scopes: WorkerScopes;
  /** Present when the VM stack is composed (T8a): the agents' sessions start in their VMs through it. */
  readonly vmLaunch?: VmLaunch | undefined;
  /** The owner's box projects (the projects module's source): a cwd under a box root is a box session, never a host path (boxes B1). */
  readonly boxes?: () => ProjectBoxSource | undefined;
  /** A member runs in a box only: a host row never launches a worker for them (M14). */
  readonly isMember: IsMember;
  /** The providers a member may use in the model pickers (M14). */
  readonly providers: SessionModelsDeps["providers"];
  /** The instance owner, whom adopted sessions belong to (M4R61); null before setup. */
  ownerId(): string | null;
  /** Once per adopted row, after its insert (agreement 8); M5 wires it to the taint of adopted sessions. */
  readonly onAdopted?: (sessionId: string) => void;
  /** After a worker exited: its session and the end of its output (the supervisor keeps 8 KiB). */
  readonly onWorkerExit?: (sessionId: string, info: { exit: WorkerExit; outputTail: string }) => void;
  /** The runs registry (M10R84): a failure in it never reaches a session. */
  readonly runs?: RunObserver;
}

export interface SessionsModule {
  readonly rpc: SessionsRpc & ShellRpc;
  /** The download route of HTML exports (ADR 0006). It checks the session cookie itself, with `authenticate`. */
  mountExportRoute(
    app: Hono,
    authenticate: (cookieHeader: string | undefined) => { userId: string } | null,
  ): void;
  /** What the search module reads from sessions. */
  readonly scanPort: SessionsScanPort;
  shutdownAll(): Promise<void>;
  /** The owner of a session, or null when there is none: the policy module's late-bound lookup (M5R56). */
  ownerOf(sessionId: string): string | null;
  /** The folder of the owner's session; null when there is none or it is another owner's (Task 29a). */
  cwdOf(ownerId: string, sessionId: string): string | null;
  /**
   * True for a session that runs in a VM: an agent's (thread, task or child) or a project box's. The profile reader skips
   * project files for it (W5-R27): its folder is the VM's, never a host folder to hand a Pi helper.
   */
  runsInVm(sessionId: string): boolean;
  inspect(sessionId: string): { pid: number | undefined; rssMb: number | null } | null;
  /** A trust decision applies at the next open (M7R105): releases the owner's workers in the folder or below. */
  restartFolder(ownerId: string, folder: string): number;
  /** Stops the worker of the owner's quiet session (M9R113): `released`, `busy` (left alone) or `cold` (no worker). */
  releaseIdle(ownerId: string, sessionId: string): "released" | "busy" | "cold";
  /**
   * What a VM mirror says to a session (R14, AVM-E21): a notice in its thread and the taint of ADR 0074's outside-write
   * detection (a session whose file the VM rewrote may hold content pap never fenced).
   */
  readonly mirror: {
    notice(sessionId: string, text: string, now?: true): void;
    taint(sessionId: string): void;
  };
  /** The only way lanes touch sessions (M9R37). */
  readonly lanes: SessionsLanePort;
  /** The lanes module fills the hooks around a prompt and a run's end (M9R114). */
  setLaneHooks(hooks: LaneRunHooks): void;
  /** What the automation and runs modules may do to a session (M10R32). */
  readonly automation: SessionsAutomationPort;
  /** What the projects module asks when a box project is deleted (boxes B1). */
  readonly projectCleanup: SessionsProjectPort;
  /** What a member's delete asks (A5b): all their sessions and the files kept for them. */
  readonly ownerCascade: SessionsOwnerCascade;
  /** What the agents module and the runner may do to the sessions of agents (M11R50). */
  readonly agentSessions: SessionsAgentPort;
  /** What the subagents module may do to the child sessions of a parent (M11R136). */
  readonly child: SessionsChildPort;
  /** The mode in force for a session (the effective mode of an agent thread): what the usage resume reads (M10R104). */
  readonly modeOf: (ownerId: string, sessionId: string) => ApprovalMode;
  /** Owner a5: an agent thread whose sandbox is on now and at its worker's start (the usage resume reads it). */
  readonly sandboxedThread: AgentSurface["sandboxedThread"];
  /** Who a session is (M11R36), the owner's browser-only approvals (M11R39) and the late-bound ports (M11R42). */
  readonly kindOf: AgentSurface["kindOf"];
  /** Only the spending side: an approval is noted by the browser answer path alone. */
  readonly approvedCalls: Pick<AgentSurface["approvedCalls"], "take">;
  setAgentPorts: AgentSurface["setAgentPorts"];
  /** The hosts the owner allowed for agent threads (owner a2): the `network.request` handler and, later, the egress proxy read it. */
  readonly hostGrants: Pick<AgentSurface["hostGrants"], "has" | "of">;
  /** The project box a session runs in and its host list now; null for a host session (`network.request`, task A7). */
  readonly projectBoxOf: AgentSurface["projectBoxOfSession"];
}

export function createSessionsModule(deps: SessionsModuleDeps): SessionsModule {
  const logger = deps.logger.child({ module: "sessions" });
  const { config } = deps;
  if (config.testProviderScript) {
    logger.warn("test_provider_enabled", { note: "sessions run on a scripted model: for tests only" });
  }
  // Pi derives its session directory from PI_CODING_AGENT_DIR, and the worker refuses to start when that differs from
  // the agent directory of its init record. PAP_TEST_PROVIDER goes with a test script and nothing else (ADR 0001).
  const env = workerEnv(deps.env, {
    PI_CODING_AGENT_DIR: config.piAgentDir,
    ...(config.testProviderScript ? { PAP_TEST_PROVIDER: "1" } : {}),
  });
  // What an earlier daemon left in the exports directory goes before anything can be exported (M2R96).
  const exports = createExports({ dir: join(config.home, "exports"), clock: deps.clock, logger });
  exports.purgeAll();
  // The working copies of sources are deleted when each fork ends; a crash in the middle leaves one, deleted here.
  const forkTmpDir = join(config.home, "fork-tmp");
  purgeForkTmp(forkTmpDir, logger);
  const store = createSessionsStore(deps.db);
  const laneHooks = createLaneHooks({
    clock: deps.clock,
    logger,
    infoOf: (sessionId) => laneInfoOf(store, service.laneProbe, sessionId),
  });
  // A mirror notice (R14, AVM-E29) can come before the session is live: it waits and is posted when the session is.
  const noticeLive = (sessionId: string, text: string): boolean => {
    const session = service.laneProbe.live.get(sessionId);
    session?.notice({ level: "warning", text });
    return session !== undefined;
  };
  const taintOutside = outsideToolResultsTaint({
    store,
    policy: deps.policy,
    audit: deps.audit,
    logger,
  });
  const held = createHeldNotices({ post: (id, text) => noticeLive(id, text), logger });
  const service = createSessionsService({
    laneHooks,
    onSessionStarted: held.flush,
    store,
    exports,
    clock: deps.clock,
    logger,
    hub: deps.hub,
    policy: deps.policy,
    projects: deps.projects,
    audit: deps.audit,
    attachments: deps.attachments,
    containment: deps.scopes.enabled ? "scope" : "none",
    limits: { maxWorkers: config.maxWorkers, minFreeMemMb: config.minFreeMemMb },
    idleMs: config.workerIdleMs,
    worker: {
      agentDir: config.piAgentDir,
      papHome: config.home,
      umask: deps.workerUmask,
      testProviderScript: config.testProviderScript,
    },
    newId,
    ownerId: deps.ownerId,
    ...(deps.onAdopted ? { onAdopted: deps.onAdopted } : {}),
    onOutsideToolResults: taintOutside,
    loadTranscript: () => loadTranscriptReader({ logger, clock: deps.clock }),
    loadWriter: () => loadPiWriter(forkTmpDir, { logger }),
    freeMemMb: () => Math.floor(freemem() / 1_048_576),
    spawn: (cwd, extraEnv) => {
      const scope = deps.scopes.next();
      return spawnWorker({
        entry: config.piHostEntry,
        execArgv: config.piHostExecArgv,
        cwd,
        env: extraEnv ? { ...env, ...extraEnv } : env,
        clock: deps.clock,
        logger: logger.child({ component: "worker", ...(scope ? { unit: scope.unit } : {}) }),
        ...(scope ? { scope } : {}),
      });
    },
    ...(deps.onWorkerExit ? { onWorkerExit: deps.onWorkerExit } : {}),
    ...(deps.runs ? { runs: deps.runs } : {}),
    isMember: deps.isMember,
    providers: deps.providers,
    ...(deps.boxes ? { boxes: deps.boxes } : {}),
    ...(deps.vmLaunch ? { vmLaunch: deps.vmLaunch } : {}),
    admission: createAdmission({
      clock: deps.clock,
      logger,
      sessionsDir: join(config.piAgentDir, "sessions"),
      minFreeDiskMb: config.minFreeDiskMb ?? DEFAULT_MIN_FREE_DISK_MB,
    }),
  });
  // Rows stored before M4 get the project of their folder; a failure here never stops the boot (M4R29).
  try {
    service.backfillProjects();
  } catch (error) {
    logger.error("session_projects_backfill_failed", { err: error });
  }
  service.startOrganiser();
  // A prompt file whose session is gone is not kept (W5-R62); a read-only database changes nothing.
  if (!store.readOnly) service.child.sweepPrompts();
  deps.hub.registerSnapshot("session", (key) => service.snapshot(key));
  // The key is the owner's id, taken from the transport: any key answers, empty for a person without sessions.
  deps.hub.registerSnapshot("shell", (ownerId) => service.shellSnapshot(ownerId));
  return {
    rpc: { ...sessionsRpc(service), ...shellRpc(service) },
    mountExportRoute: (app, authenticate) => mountExportRoute(app, { exports, authenticate, logger }),
    scanPort: service.scanPort,
    async shutdownAll() {
      try {
        await service.shutdownAll();
      } finally {
        exports.stop();
      }
    },
    ownerOf: (sessionId) => store.get(sessionId)?.ownerId ?? null,
    cwdOf(ownerId, sessionId) {
      const row = store.get(sessionId);
      return row?.ownerId === ownerId ? row.cwd : null;
    },
    runsInVm(sessionId) {
      const row = store.get(sessionId);
      // A gated owner's folder is never read on the host (the trust store, a helper's cwd): fails closed for them.
      return (
        row !== undefined &&
        (row.agentId !== undefined || service.agent.vmLayoutOf(row) !== null || deps.isMember(row.ownerId))
      );
    },
    inspect: (sessionId) => service.inspect(sessionId),
    mirror: {
      notice: (sessionId, text, now) => {
        if (noticeLive(sessionId, text)) return;
        // `now`: no start follows (J1b M1), so whoever watches the session is told directly; otherwise it waits for the next start.
        if (now) deps.hub.publish("session", sessionId, { kind: "notice", level: "warning", text });
        else held.hold(sessionId, text);
      },
      taint: taintOutside,
    },
    restartFolder: (ownerId, folder) => service.restartFolder(ownerId, folder),
    releaseIdle: (ownerId, sessionId) => service.releaseIdle(ownerId, sessionId),
    lanes: createSessionsLanePort({
      service,
      store,
      marks: store.marks,
      probe: service.laneProbe,
      waiting: laneHooks.waiting,
      logger,
    }),
    setLaneHooks: laneHooks.set,
    automation: service.automation,
    projectCleanup: service.projectCleanup,
    ownerCascade: service.ownerCascade,
    agentSessions: service.agentSessions,
    child: service.child,
    modeOf: service.modeOf,
    sandboxedThread: service.agent.sandboxedThread,
    kindOf: service.agent.kindOf,
    approvedCalls: { take: service.agent.approvedCalls.take },
    setAgentPorts: service.agent.setAgentPorts,
    hostGrants: service.agent.hostGrants,
    projectBoxOf: service.agent.projectBoxOfSession,
  };
}
