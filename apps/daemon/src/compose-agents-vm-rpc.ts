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
  mountAgentFilesRoute,
  secretsDirOf,
  startFilesTrashSweep,
} from "./modules/agent-vm/index.ts";

export type AgentsVmRpc = Pick<
  HandlerTable,
  | "agents.vm.setClaudeToken"
  | "agents.vm.clearClaudeToken"
  | "agents.vmStatus"
  | "agents.files.list"
  | "agents.files.remove"
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
  };
  readonly rpc: AgentsVmRpc;
  /** Stops the daily sweep of the files trash. */
  stopSweep(): void;
  bindStatus(view: (ownerId: string) => Promise<VmStatusView>): void;
  bindAgents(agents: { ownerOf(agentId: string): string | null }): void;
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
  const stopSweep = startFilesTrashSweep({ files: agentFiles, clock, logger: agentLogger });
  let vmView: ((ownerId: string) => Promise<VmStatusView>) | undefined;
  return {
    claudeToken,
    stopSweep,
    shared: {
      claudeToken,
      agentFiles,
      agentFilesLink: {
        paths: (_ownerId, agentId) => agentFiles.list(agentId).map((file) => file.path),
        dispose: (agentId, stamp) => agentFiles.dispose(agentId, stamp),
      },
    },
    bindStatus: (view) => void (vmView = view),
    bindAgents: (agents) => void (ownerOf = (agentId) => agents.ownerOf(agentId)),
    mount: (app, authenticate) =>
      mountAgentFilesRoute(app, {
        caller: httpCaller(authenticate, NO_CLIENT_PATHS),
        service: filesService,
        logger: agentLogger,
      }),
    rpc: {
      "agents.vmStatus": async (_params, ctx) =>
        vmView ? vmView(ctx.caller.userId) : Promise.reject(new PapError("internal")),
      ...agentFilesRpc(filesService),
      ...agentsVmTokenRpc(
        createClaudeTokenService(claudeToken, (caller) => requireStepUp(caller, clock.now()), audit),
      ),
    },
  };
}
