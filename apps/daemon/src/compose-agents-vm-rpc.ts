import { type HandlerTable, PapError, type VmStatusView } from "@pap/contracts";
import type { Hono } from "hono";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import type { Caller } from "@pap/contracts";
import { httpCaller } from "./kernel/http/caller.ts";
import { NO_CLIENT_PATHS } from "./kernel/ws/client-path-gate.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import { createVaultStore, vaultRootOf } from "./modules/secrets/index.ts";
import type { AgentLinks } from "./modules/agents/index.ts";
import {
  type AgentFiles,
  agentFilesRpc,
  agentsVmTokenRpc,
  type ClaudeTokens,
  createAgentFiles,
  createAgentFilesService,
  createClaudeTokenService,
  createClaudeTokens,
  createLaunchLog,
  createLaunchStop,
  type LaunchLog,
  type LaunchStop,
  mountAgentFilesRoute,
  secretsDirOf,
  startFilesTrashSweep,
} from "./modules/agent-vm/index.ts";

export type AgentsVmRpc = Pick<
  HandlerTable,
  | "agents.vm.setClaudeToken"
  | "agents.vm.clearClaudeToken"
  | "agents.vmStatus"
  | "agents.startBox"
  | "agents.files.list"
  | "agents.files.remove"
  | "subscribe.launches"
  | "launches.log"
  | "launches.stop"
>;

/**
 * The `agents.vm.*` / `agents.vmStatus` handlers, and each user's Claude token (the vault's user scope) behind the first two. `agents.purgeTrash` is the agents module's.
 * The agent file store (`$PAP_HOME/secrets/agent-files`) is built here too, with its two methods and `PUT /agent-files`; the agents
 * registry that says who owns an agent is bound later (`bindAgents`), until then no agent is anyone's.
 * `agents.vmStatus` is bound to the VM composition's view (`bindStatus`) before the server listens (T18).
 */
export function composeAgentsVmRpc(
  config: Pick<Config, "home">,
  logger: Logger,
  clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">,
  audit: Pick<AuditPort, "append">,
): {
  readonly claudeToken: ClaudeTokens;
  /** What the daemon's core carries: the Claude token store and the agent file store, with the agents module's link to it. */
  readonly shared: {
    readonly claudeToken: ClaudeTokens;
    readonly agentFiles: AgentFiles;
    readonly agentFilesLink: NonNullable<AgentLinks["files"]>;
    /** "Show the log": the VM composition binds its source once the projects are known. */
    readonly launchLog: LaunchLog;
    /** "Stop" on a launch's ask: the VM composition binds the registry and the runtime's stop. */
    readonly launchStop: LaunchStop;
  };
  readonly rpc: AgentsVmRpc;
  /** Stops the daily sweep of the files trash. */
  stopSweep(): void;
  bindStatus(view: (ownerId: string) => Promise<VmStatusView>): void;
  /** `agents.vmStatus` and `agents.startBox` (an owner's own agent only: the registry answers `not_found` for any other) to the composed VM stack, before the server listens. */
  bindVm(vm: {
    readonly status: { view(ownerId: string): Promise<VmStatusView> };
    startAgent(ownerId: string, agentId: string): Promise<void>;
  }): void;
  bindAgents(agents: { ownerOf(agentId: string): string | null }): void;
  /** What the explorer needs of an agent: its owner (null until the registry is bound) and its imported credential paths. */
  readonly agentsPort: {
    ownerOf(agentId: string): string | null;
    importedOf(agentId: string): readonly string[];
  };
  /** `PUT /agent-files`, cookie only. */
  mount(app: Hono, authenticate: (header: string | undefined) => Caller | null): void;
} {
  const claudeToken = createClaudeTokens({
    // A second reader of the same files, without the start-up sweep (that belongs to the daemon's own store), like github's.
    vault: createVaultStore(vaultRootOf(config.home), { sweep: false }),
    clock,
    secretsDir: secretsDirOf(config.home),
    logger: logger.child({ module: "agent-vm" }),
  });
  const agentLogger = logger.child({ module: "agent-vm" });
  const agentFiles = createAgentFiles({ secretsDir: secretsDirOf(config.home), logger: agentLogger });
  let ownerOf: (agentId: string) => string | null = () => null;
  const filesService = createAgentFilesService({
    files: agentFiles,
    owns: (ownerId, agentId) => ownerOf(agentId) === ownerId,
    audit,
  });
  const launchLog = createLaunchLog();
  const launchStop = createLaunchStop();
  const stopSweep = startFilesTrashSweep({ files: agentFiles, clock, logger: agentLogger });
  let vmView: ((ownerId: string) => Promise<VmStatusView>) | undefined;
  let startAgent: ((ownerId: string, agentId: string) => Promise<void>) | undefined;
  return {
    claudeToken,
    stopSweep,
    shared: {
      claudeToken,
      agentFiles,
      launchLog,
      launchStop,
      agentFilesLink: {
        paths: (_ownerId, agentId) => agentFiles.list(agentId).map((file) => file.path),
        dispose: (agentId, stamp) => agentFiles.dispose(agentId, stamp),
      },
    },
    agentsPort: {
      ownerOf: (agentId) => ownerOf(agentId),
      importedOf: (agentId) => agentFiles.hiddenOf(agentId),
    },
    bindStatus: (view) => void (vmView = view),
    bindVm(vm) {
      vmView = vm.status.view;
      startAgent = vm.startAgent;
    },
    bindAgents(agents) {
      ownerOf = (agentId) => agents.ownerOf(agentId);
      launchLog.bindAgentOwner(ownerOf);
    },
    mount: (app, authenticate) =>
      mountAgentFilesRoute(app, {
        caller: httpCaller(authenticate, NO_CLIENT_PATHS),
        service: filesService,
        logger: agentLogger,
      }),
    rpc: {
      "agents.vmStatus": async (_params, ctx) =>
        vmView ? vmView(ctx.caller.userId) : Promise.reject(new PapError("internal")),
      "agents.startBox": async ({ agentId }, ctx) => {
        if (startAgent === undefined) throw new PapError("internal");
        await startAgent(ctx.caller.userId, agentId);
        return { ok: true };
      },
      "subscribe.launches": async (params, ctx) => ({
        sub: ctx.openSubscription("launches", ctx.caller.userId, params.after),
      }),
      "launches.log": (params, ctx) => launchLog.read(ctx.caller, params.box),
      "launches.stop": (params, ctx) => launchStop.stop(ctx.caller, params.id),
      ...agentFilesRpc(filesService),
      ...agentsVmTokenRpc(
        createClaudeTokenService(claudeToken, (caller) => requireStepUp(caller, clock.now()), audit),
      ),
    },
  };
}
