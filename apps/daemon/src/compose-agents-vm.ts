import { availableParallelism } from "node:os";
import type { VmLayout } from "@pap/contracts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  type AgentRuntimeBackend,
  createAgentRuntime,
  createGateway,
  createLaunchTokens,
  createProcessBackend,
  layoutOf,
  type MirrorHooks,
  createMirrorInputs,
} from "./modules/agent-vm/index.ts";
import {
  createVmLaunch,
  type MirrorInputs,
  type SessionRow,
  taskKeyOf,
  type VmLaunch,
} from "./modules/sessions/index.ts";

/** What the composition reads of the daemon's core. */
export interface AgentsVmCore {
  readonly config: Pick<
    Config,
    | "home"
    | "agentsRuntime"
    | "agentsMemoryMaxMb"
    | "testAgentRuntime"
    | "testProviderScript"
    | "workerIdleMs"
    | "minFreeDiskMb"
  >;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What a test, or a later task, supplies to the composition; nothing is needed in host mode. */
export interface AgentsVmSeams {
  /** `PAP_TEST_AGENT_RUNTIME=process`: how the guest starts (J1 wires the real entry). */
  readonly process?: { guestEntry: string; execArgv: readonly string[]; imageAgentSource: string };
  /** Tests only: replaces the process backend; it learns the gateway's address when asked. */
  readonly backend?: (gatewayAddress: () => { host: string; port: number }) => AgentRuntimeBackend;
  /** Tests only: replaces the daemon's mirrors of the VM session files (T9b). */
  readonly mirrors?: MirrorInputs;
  /** The image tag an agent's VM starts with (T14b's image policy replaces the test tag). */
  readonly imageTagOf?: (agentId: string) => string;
}

/** What the daemon's other compositions are handed in `vm` mode. */
export interface AgentsVm {
  readonly runtime: AgentRuntime;
  /** The sessions' launcher (`SessionsModuleDeps.vmLaunch`). */
  readonly launch: VmLaunch;
  /** The shared VM predicate: a row's layout, null for a row that is not an agent's (R15). */
  vmLayoutOf(row: SessionRow): VmLayout | null;
  /** By agent (the gate, the prompt chips): every agent runs in a VM in this mode. Not the agent port's `runsInVm`, which is by session. */
  agentRunsInVm(ownerId: string, agentId: string): boolean;
  /** The mirrors of the VM session files (R23): `inputFor` is the launcher's. */
  readonly mirrors: MirrorInputs;
  /**
   * Where a mirror's notices and taints go (R14, R32): the sessions that post and taint are composed after this, so they are
   * bound later. Until then a notice or a taint is logged, never lost silently.
   */
  bindMirrorHooks(hooks: MirrorHooks): void;
  /** The host's ceilings for an agent's resources (RT-30). */
  resourceHost(): { memoryCapMb: number; cores: number };
  /** Where the gateway listens (the process backend's loopback port). */
  readonly gatewayPort: number;
}

const TEST_IMAGE_TAG = `pap-agent-agent-${"0".repeat(64)}`;

/**
 * `PAP_AGENTS_RUNTIME=vm` (T8a): the launch tokens, the gateway, the runtime and the agents' launcher. The gateway listens
 * before this returns, so before the daemon accepts a connection and no local user can take its port first (RT-35); the boot
 * `stopAll` runs before any spawn (RT-42), and a failure of it stops the boot. In `host` mode it composes nothing.
 */
export async function composeAgentsVm(
  core: AgentsVmCore,
  closers: Array<{ readonly name: string; close(): void | Promise<void> }>,
  seams: AgentsVmSeams = {},
): Promise<AgentsVm | null> {
  const { config, clock, logger } = core;
  if (config.agentsRuntime !== "vm") return null;
  // The Kata backend arrives in T15: until then only the test process backend can start a VM, and the boot stops without it.
  if (seams.backend === undefined) {
    if (config.testAgentRuntime !== "process")
      throw new Error("PAP_AGENTS_RUNTIME=vm needs the Kata backend, which arrives later: no VM can start");
    if (seams.process === undefined) throw new Error("the process backend needs the guest seam");
    if (config.testProviderScript === null)
      throw new Error("PAP_TEST_AGENT_RUNTIME needs the provider script");
  }
  const agentsLogger = logger.child({ module: "agent-vm" });
  const tokens = createLaunchTokens();
  // AVM-P8: the gateway reads the image of a launch through the runtime, which exists after it (no cycle).
  let imageOf: AgentRuntime["imageOf"] = () => null;
  const gateway = createGateway({ tokens, clock, logger: agentsLogger, imageOf: (id) => imageOf(id) });
  const { port } = await gateway.listen("127.0.0.1", 0);
  const address = () => ({ host: "127.0.0.1", port });
  try {
    const guest = seams.process;
    const backend =
      seams.backend?.(address) ??
      createProcessBackend({
        testSwitch: config.testAgentRuntime,
        papHome: config.home,
        guestEntry: guest?.guestEntry ?? "",
        execArgv: guest?.execArgv ?? [],
        imageAgentSource: guest?.imageAgentSource ?? "",
        gatewayAddress: address,
        providerScript: config.testProviderScript ?? "",
        clock,
        logger: agentsLogger,
      });
    const runtime = createAgentRuntime({
      backend,
      gateway,
      tokens,
      clock,
      logger: agentsLogger,
      memoryCapMb: config.agentsMemoryMaxMb,
      idleMs: config.workerIdleMs,
      layout: (spec) => layoutOf("process", config.home, spec),
      // The relay link is J1's, the crash pause and the capacity notice T15's.
      onLaunch: () => {},
      onLaunchEnd: () => {},
      onCrashPause: (agentId) => agentsLogger.error("agent_vm_crash_pause_unwired", { agentId }),
      notifyCapacity: () => {},
    });
    imageOf = runtime.imageOf;
    await runtime.stopAll();
    let hooks: MirrorHooks = {
      notice: (sessionId) => agentsLogger.warn("agent_mirror_notice_unbound", { sessionId }),
      taint: (sessionId) => agentsLogger.error("agent_mirror_taint_unbound", { sessionId }),
      canWrite: () => true,
    };
    const own =
      seams.mirrors === undefined
        ? createMirrorInputs({
            papHome: config.home,
            clock,
            logger: agentsLogger,
            minFreeDiskMb: config.minFreeDiskMb,
            notice: (sessionId, text) => hooks.notice(sessionId, text),
            taint: (sessionId) => hooks.taint(sessionId),
            canWrite: () => hooks.canWrite(),
          })
        : null;
    const mirrors: MirrorInputs = seams.mirrors ?? (own as NonNullable<typeof own>);
    own?.start();
    if (own) closers.push({ name: "agent_mirrors", close: () => own.close() });
    closers.push({
      name: "agent_vm",
      close: async () => {
        try {
          await runtime.stopAll();
        } finally {
          await gateway.close();
        }
      },
    });
    const vmLayoutOf = (row: SessionRow): VmLayout | null =>
      row.agentId === undefined
        ? null
        : layoutOf("process", config.home, { agentId: row.agentId, taskKey: taskKeyOf(row) });
    return {
      runtime,
      launch: createVmLaunch({
        runtime,
        papHome: config.home,
        layoutOf: vmLayoutOf,
        imageTagOf: seams.imageTagOf ?? (() => TEST_IMAGE_TAG),
        mirrors,
        logger: agentsLogger,
      }),
      vmLayoutOf,
      mirrors,
      bindMirrorHooks(next) {
        hooks = next;
      },
      agentRunsInVm: () => true,
      resourceHost: () => ({ memoryCapMb: config.agentsMemoryMaxMb, cores: availableParallelism() }),
      gatewayPort: port,
    };
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
