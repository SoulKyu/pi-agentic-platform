import { type HandlerTable, PapError, type VmStatusView } from "@pap/contracts";
import type { Hono } from "hono";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import type { Caller } from "@pap/contracts";
import { httpCaller } from "./kernel/http/caller.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import type { AgentLinks } from "./modules/agents/index.ts";
import {
  type AgentFiles,
  agentFilesRpc,
  agentsVmTokenRpc,
  type ClaudeTokenStore,
  createAgentFiles,
  createAgentFilesService,
  createClaudeTokenService,
  createClaudeTokenStore,
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
 * The `agents.vm.*` / `agents.vmStatus` handlers, and the Claude token store behind the first two (`$PAP_HOME/secrets/claude-token`). `agents.purgeTrash` is the agents module's.
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
  readonly claudeToken: ClaudeTokenStore;
  /** What the daemon's core carries: the Claude token store and the agent file store, with the agents module's link to it. */
  readonly shared: {
    readonly claudeToken: ClaudeTokenStore;
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
  const claudeToken = createClaudeTokenStore({
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
        caller: httpCaller(authenticate),
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
