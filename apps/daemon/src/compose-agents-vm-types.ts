import type { VmLayout } from "@pap/contracts";
import type { BoxStack } from "./compose-boxes-wiring.ts";
import type { Boxes } from "./compose-boxes.ts";
import type { composeVmProxy } from "./compose-agents-vm-proxy.ts";
import type { AgentsVmLate } from "./compose-agents-vm-late.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Db } from "./kernel/db/database.ts";
import type { Config } from "./kernel/config.ts";
import type { LaunchRegistry } from "./kernel/launches.ts";
import type { Logger } from "./kernel/logger.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import type {
  AgentRuntime,
  AgentFilesPort,
  ClaudeTokens,
  LaunchLog,
  LaunchStop,
  MirrorHooks,
  RelayLink,
  VmStatus,
} from "./modules/agent-vm/index.ts";
import type { AgentVmLink } from "./modules/agents/index.ts";
import type { MirrorInputs, SessionRow, VmLaunch } from "./modules/sessions/index.ts";

/** What the composition reads of the daemon's core. */
export interface AgentsVmCore {
  readonly config: Pick<
    Config,
    | "home"
    | "agentsRuntimeSet"
    | "agentsMemoryMaxMb"
    | "testAgentRuntime"
    | "testVmdSocket"
    | "dev"
    | "devVmd"
    | "testProviderScript"
    | "workerIdleMs"
    | "minFreeDiskMb"
    | "piHostEntry"
    | "piHostExecArgv"
    | "piAgentDir"
  > &
    Partial<Pick<Config, "testGithubOrigin">>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Names the install's owner, whose vault the image build scans (R13). Absent: nobody. */
  readonly db?: Db;
  /** The stream hub: the launch registry publishes on `launches` and answers its snapshot. Absent: launches are kept, not published. */
  readonly hub?: Pick<StreamHub, "publish" | "registerSnapshot" | "hasSubscribers">;
  /** The GitHub box tokens in use (`GithubTokens.liveValues`): masked by value like the owner's other secrets. */
  readonly githubLive?: () => readonly string[];
  /** The daemon's environment: the relay child's allowlist is cut from it. */
  readonly env: NodeJS.ProcessEnv;
  /** The database is read-only: a mirror's notice and taint wait (RT-42). */
  readonly readOnly: boolean;
  /** The owner's Claude token (host and vm modes keep it; only vm mode has a relay to push it to). */
  readonly claudeToken: ClaudeTokens;
  /** The agent file store: its trash is purged and swept with the agent's disk. */
  readonly agentFiles?: AgentFilesPort | undefined;
  /** "Show the log" (`launches.log`): bound to the project owners and the build tails once the projects exist. Absent: unbound. */
  readonly launchLog?: LaunchLog;
  /** "Stop" (`launches.stop`): bound to the launch registry and the runtime once they exist. Absent: unbound. */
  readonly launchStop?: LaunchStop;
}

/** What the daemon's other compositions are handed in `vm` mode. */
export interface AgentsVm {
  readonly runtime: AgentRuntime;
  /** The live launches of boxes (kernel port): opened by the launch paths, read by the box control and the `launches` stream. */
  readonly launches: LaunchRegistry;
  /** The sessions' launcher (`SessionsModuleDeps.vmLaunch`). */
  readonly launch: VmLaunch;
  readonly boxes: Boxes; // the project boxes: bound with `late.boxes`, read by the sessions and the box crash pause
  /** What the box control needs of the stack (Kata's client, the launch gate): `composeBoxWiring` builds the control from it. */
  readonly boxStack: BoxStack;
  /** The shared VM predicate: a row's layout (an agent's, or a project box's), null for any other row (R15). */
  vmLayoutOf(row: SessionRow): VmLayout | null;
  /** The mirrors of the VM session files (R23): `inputFor` is the launcher's. */
  readonly mirrors: MirrorInputs;
  /** Where a mirror's notices and taints go (R14, R32): composed after the sessions, so bound later; until then logged. */
  bindMirrorHooks(hooks: MirrorHooks): void;
  /** What exists only after the sessions, models and agents (AVM-E21, T12): the mirror's hooks, the proxy's taint, the relay's policy. */
  bindLate(late: AgentsVmLate): void;
  /** The relay link, or null when the composition runs without one (`relay: "off"`). Tests wait on `whenReady`. */
  readonly relay: RelayLink | null;
  /** `agents.vmStatus` and the launch refusal of an unusable stack (T18). */
  readonly status: VmStatus;
  /** The host's ceilings for an agent's resources (RT-30). */
  resourceHost(): { memoryCapMb: number; cores: number };
  /** At save, an agent's package picks (ids) must be ones the owner's Pi packages hold (AVM-E33); fails closed before the late binding. */
  checkPackages(ids: readonly string[]): Promise<void>;
  /** Where the gateway and the egress proxy listen (the process backend's loopback ports). */
  readonly gatewayPort: number;
  readonly proxyPort: number;
  /** What the agents module asks of the VM runtime: stops, a delete's disk and mirrors, "Purge now", Resume (T15). */
  readonly agentLink: AgentVmLink;
  /** `agents.startBox`: the agent's thread VM with its guest only, so its files can be browsed. Bound to the agents' registry by `bindLate`. */
  startAgent(ownerId: string, agentId: string): Promise<void>;
  /** Where the runtime's crash pause goes (RT-40): the agents' registry and Inbox, which are built after this. Until then it is logged. */
  bindCrashPause(handler: (agentId: string) => void): void;
  bindRefusals: ReturnType<typeof composeVmProxy>["bindRefusals"];
}
