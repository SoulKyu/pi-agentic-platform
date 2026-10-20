import { copyFileSync, mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, extname, join } from "node:path";
import { PapError, type VmLayout } from "@pap/contracts";
import { type AgentsVmDerived, type AgentsVmLate, bindAgentsVmLate } from "./compose-agents-vm-late.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  type AgentRuntimeBackend,
  type ClaudeTokenStore,
  createImageEntries,
  createAgentRuntime,
  createGateway,
  createLaunchTokens,
  createProcessBackend,
  createRelayLink,
  forkRelay,
  layoutOf,
  type MirrorHooks,
  createMirrorInputs,
  relayEnv,
  relayListenOf,
  type RelayChild,
  type VmSpec,
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
    | "piHostEntry"
    | "piHostExecArgv"
    | "piAgentDir"
  >;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The daemon's environment: the relay child's allowlist is cut from it. */
  readonly env: NodeJS.ProcessEnv;
  /** The database is read-only: a mirror's notice and taint wait (RT-42). */
  readonly readOnly: boolean;
  /** The owner's Claude token (host and vm modes keep it; only vm mode has a relay to push it to). */
  readonly claudeToken: ClaudeTokenStore;
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
  /** `"off"`: no relay child (unit tests of other things); a `fork`: the test's own child. Default: the real `pap-relay`. */
  readonly relay?: "off" | { fork(): RelayChild };
  /** Resolves when the bridge address exists (pap0): the relay is started after it (AVM-P10). Default: at once. */
  readonly bridgeReady?: () => Promise<void>;
  /** Tests only: told of every VM the backend starts and stops (a second open reuses the VM; a crash restarts it). */
  readonly observe?: {
    started?(spec: VmSpec): void;
    stopped?(agentId: string, taskKey: string | null): void;
  };
  /** Tests only: handed the composition once it is built (the int beds stop a VM or wait for the relay through it). */
  readonly expose?: (vm: AgentsVm) => void;
  /** The relay child's node flags (default: the workers'); a test whose workers carry the network guard gives its own. */
  readonly relayExecArgv?: readonly string[];
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
  /**
   * What exists only after the sessions, the models and the agents (AVM-E21, T12): binds the mirror's notice and taint to the
   * sessions, and the relay's per-agent policy to the models, the agents' pause and budget and the runs.
   */
  bindLate(late: AgentsVmLate): void;
  /** The relay link, or null when the composition runs without one (`relay: "off"`). Tests wait on `whenReady`. */
  readonly relay: ReturnType<typeof createRelayLink> | null;
  /** The host's ceilings for an agent's resources (RT-30). */
  resourceHost(): { memoryCapMb: number; cores: number };
  /** At save, an agent's package picks (ids) must be ones the owner's Pi packages hold (AVM-E33); fails closed before the late binding. */
  checkPackages(ids: readonly string[]): Promise<void>;
  /** Where the gateway listens (the process backend's loopback port). */
  readonly gatewayPort: number;
}

const TEST_IMAGE_TAG = `pap-agent-agent-${"0".repeat(64)}`;

/** Until the late binding the relay learns no model for any agent: it refuses every request (fail closed). */
const failClosed = { policyOf: async () => ({ models: [], claude: false, blocked: null }) } as const;
const notBound = (): never => {
  throw new PapError("internal");
};

/** The scripted provider copied into the VM's folder at each worker start (a test may rewrite it between starts). */
const scriptCopier = (source: string) => (layout: VmLayout) => {
  const run = join(layout.root, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const target = join(run, "provider-script.json");
  copyFileSync(source, target);
  return target;
};

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
    const real =
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
    const backend: AgentRuntimeBackend =
      seams.observe === undefined
        ? real
        : {
            ...real,
            start: (spec, launch) => (seams.observe?.started?.(spec), real.start(spec, launch)),
            stop: (agentId, taskKey) => (
              seams.observe?.stopped?.(agentId, taskKey),
              real.stop(agentId, taskKey)
            ),
          };
    // The relay (R13): `pap-relay` listens on the bridge address (loopback under the process backend and test backends).
    const loopback = config.testAgentRuntime === "process" || seams.backend !== undefined;
    const lateHolder: { late: AgentsVmDerived | null } = { late: null };
    const relay =
      seams.relay === "off"
        ? null
        : createRelayLink({
            fork:
              seams.relay?.fork ??
              (() =>
                forkRelay({
                  entry: join(dirname(config.piHostEntry), "relay", `main${extname(config.piHostEntry)}`),
                  execArgv: seams.relayExecArgv ?? config.piHostExecArgv,
                  listen: relayListenOf(loopback),
                  env: relayEnv(core.env, config.piAgentDir, config.testProviderScript),
                  clock,
                  logger: agentsLogger,
                })),
            clock,
            logger: agentsLogger,
            ...(seams.bridgeReady ? { bridgeReady: seams.bridgeReady } : {}),
            policyOf: (agentId) => (lateHolder.late ?? failClosed).policyOf(agentId),
            claudeToken: () => core.claudeToken.load(),
            reportedTurns: (agentId) => lateHolder.late?.turnsOf(agentId) ?? 0,
            windowEnded: () => lateHolder.late?.windowEnded(),
          });
    // The bridge's policy follows the token too: set it and the agents with the bridge may use it at once.
    core.claudeToken.onChange((token) => (relay?.setClaudeToken(token), relay?.refreshAll()));
    const imageEntries = createImageEntries(agentsLogger);
    const runtime = createAgentRuntime({
      backend,
      gateway,
      tokens,
      clock,
      logger: agentsLogger,
      memoryCapMb: config.agentsMemoryMaxMb,
      idleMs: config.workerIdleMs,
      layout: (spec) => layoutOf("process", config.home, spec),
      // The crash pause and the capacity notice are T15's.
      onLaunch: (grant) => relay?.grant(grant),
      onLaunchEnd: (launchId) => relay?.revoke(launchId),
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
            notice: (sessionId, text, now) => hooks.notice(sessionId, text, now),
            taint: (sessionId) => hooks.taint(sessionId),
            canWrite: () => hooks.canWrite(),
          })
        : null;
    // AVM-E21: until the hooks are bound a notice or a taint could go nowhere, so no VM session starts (a seam's mirrors are the test's).
    let bound = false;
    const bindHooks = (next: MirrorHooks): void => {
      hooks = next;
      bound = true;
    };
    const mirrors: MirrorInputs =
      seams.mirrors ??
      ({
        inputFor(row, resources) {
          if (!bound) throw new PapError("internal");
          return (own as NonNullable<typeof own>).inputFor(row, resources);
        },
      } satisfies MirrorInputs);
    own?.start();
    if (own) closers.push({ name: "agent_mirrors", close: () => own.close() });
    if (relay) {
      closers.push({ name: "agent_relay", close: () => relay.stop() });
      void relay.start().catch((error: unknown) => agentsLogger.error("relay_start_failed", { err: error }));
    }
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
    const composed: AgentsVm = {
      runtime,
      launch: createVmLaunch({
        runtime,
        papHome: config.home,
        layoutOf: vmLayoutOf,
        imageTagOf: seams.imageTagOf ?? (() => TEST_IMAGE_TAG),
        mirrors,
        logger: agentsLogger,
        toImageEntries: (agentId, sources) => imageEntries.toImage(agentId, sources),
        packageSources: (ids) => (lateHolder.late ? lateHolder.late.sourcesOf(ids) : notBound()),
        // AVM-E15, process backend only: the scripted provider is copied into the VM's folder and the init names that path.
        ...(config.testAgentRuntime === "process" &&
        seams.backend === undefined &&
        config.testProviderScript !== null
          ? { copyProviderScript: scriptCopier(config.testProviderScript) }
          : {}),
      }),
      vmLayoutOf,
      mirrors,
      bindMirrorHooks: bindHooks,
      bindLate(late) {
        lateHolder.late = bindAgentsVmLate(
          {
            clock,
            logger: agentsLogger,
            closers,
            relay,
            claudeToken: core.claudeToken,
            readOnly: core.readOnly,
            bindMirrorHooks: bindHooks,
          },
          late,
        );
      },
      relay,
      agentRunsInVm: () => true,
      resourceHost: () => ({ memoryCapMb: config.agentsMemoryMaxMb, cores: availableParallelism() }),
      checkPackages: (ids) => (lateHolder.late ? lateHolder.late.checkPackages(ids) : notBound()),
      gatewayPort: port,
    };
    seams.expose?.(composed);
    return composed;
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
