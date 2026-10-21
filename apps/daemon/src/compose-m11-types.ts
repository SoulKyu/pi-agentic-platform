import type { spawn } from "node:child_process";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Db } from "./kernel/db/database.ts";
import type { GitRunner } from "./kernel/git/runner.ts";
import type { Logger } from "./kernel/logger.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import type { ClaudeEnvOf } from "./compose-agents-vm-late.ts";
import type { AgentsVm } from "./compose-m11-vm.ts";
import type { AgentLinks, AgentsPort, AgentsRpc } from "./modules/agents/index.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import type { EgressPort } from "./modules/egress/index.ts";
import type { M11RunsPort } from "./compose-subagents.ts";
import type { AutomationModule } from "./modules/automation/index.ts";
import type { MemoryRpc } from "./modules/memory/index.ts";
import type { Inbox } from "./modules/inbox/index.ts";
import type { PlatformHandler, PlatformPort } from "./modules/platform/index.ts";
import type { SecretRequestsRpc, SecretsRpc } from "./modules/secrets/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SubagentsPorts, SubagentsRpc } from "./modules/subagents/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";

/** What `composeM11` reads of the daemon's core. */
export interface M11Core {
  readonly db: Db;
  readonly config: Pick<Config, "home" | "bwrapOverride" | "piAgentDir"> & Partial<Pick<Config, "userHome">>;
  /** The daemon's environment: the egress proxy's sockets live under `$XDG_RUNTIME_DIR` when it is private (W5-R42). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  /** The agent file store's link: quarantine's `files` step lists its paths, a delete sends its folder to the trash. */
  readonly agentFilesLink?: AgentLinks["files"] | undefined;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  /** Tests only: the process spawn of the sandbox probe. */
  readonly probeSpawn?: typeof spawn | undefined;
}

/** The modules `composeM11` is given once they exist; later tasks add the ones they need. */
export interface M11Modules {
  readonly sessions: Pick<
    SessionsModule,
    | "kindOf"
    | "approvedCalls"
    | "setAgentPorts"
    | "releaseIdle"
    | "automation"
    | "agentSessions"
    | "hostGrants"
    | "child"
  >;
  /** The owner's settings: their host list is what an agent's own list is judged against (W5-R36). */
  readonly policy?: {
    readonly port: {
      settings(ownerId: string): {
        readonly allowHosts: readonly string[] | null;
        readonly denylist: readonly unknown[];
      };
    };
  };
  /** The kernel git runner: the only way pap runs git, here to make an agent's home (M11R46). */
  readonly git: GitRunner;
  readonly audit: { readonly port: Pick<AuditPort, "append" | "reserve"> };
  /** The run registry's port: a thread's run start and end move the rail and the unread count. */
  readonly runs: M11RunsPort;
  /** The lanes module's folder paths: whose lane worktree a folder is in. */
  readonly lanes: {
    readonly paths: { laneOf(cwd: string): { readonly ownerId: string } | null };
    readonly note: PlatformHandler<"lane.note">;
  };
  /** M10's automation module, built before this entry: an agent's triggers and tasks (Task 10). */
  readonly automationModule: Pick<AutomationModule, "agentLink" | "bindAgents" | "agentTasks">;
  /** M10's Inbox: the delegation result's reply item, the reply a reset closes, the items a delete drops (M11R79, M11R91). */
  readonly inbox: {
    readonly agentItems: Pick<
      Inbox["agentItems"],
      "upsertAgentItem" | "resolveRef" | "removeAgentItems" | "openRefs"
    >;
  };
  readonly subagents: SubagentsPorts;
  /** ADR 0080: the Claude Code environment of a claude-bridge agent's worker, host or VM. Absent: none is set. */
  readonly claudeEnvOf?: ClaudeEnvOf | undefined;
  readonly vm?: AgentsVm | undefined;
  /** Tests only: replaces the egress proxy. The daemon never passes one: production builds the real proxy (M11R244). */
  readonly egress?: EgressPort;
  /** The owner's automation time zone: the day an agent's budget and figures count in (M11R74, M11R76). */
  readonly settings: { readonly port: Pick<SettingsModule["port"], "automation" | "agents"> };
}

export interface M11 {
  readonly platform: PlatformPort;
  /** The agents registry other M11 modules read (M11R43). */
  readonly agents: AgentsPort;
  /** What the VM runtime's late binding reads: the registry, and the owner's host list for an agent without one. */
  readonly vmLate: { agents: AgentsPort; ownerHosts(ownerId: string): readonly string[] | null };
  /** M11's RPC methods; each task adds its table here, never in `daemon.ts`. */
  readonly rpc: AgentsRpc & SecretsRpc & SecretRequestsRpc & SubagentsRpc & MemoryRpc;
  /** First in the daemon's stop: the dispatcher answers `unavailable` before the sessions' workers are stopped. */
  stop(): void;
}
