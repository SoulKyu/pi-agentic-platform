import { PapError, type VmLayout } from "@pap/contracts";
import { scriptCopier } from "./compose-agents-vm-script.ts";
import { composeAgentsLink } from "./compose-agents-vm-agents.ts";
import { composeVmProxy, type VmProxySeams } from "./compose-agents-vm-proxy.ts";
import { composeRelay } from "./compose-agents-vm-relay.ts";
import { type AgentsVmDerived, type AgentsVmLate, bindAgentsVmLate } from "./compose-agents-vm-late.ts";
import { awaitBridge, composeKata, listenGateway, type KataSeams } from "./compose-agents-vm-kata.ts";
import { kataSeamsOf, startProxy } from "./compose-agents-vm-socket.ts";
import { warnAgentsRuntimeIgnored } from "./compose-agents-runtime-warn.ts";
import { eachOwnTry } from "./compose-agents-vm-hooks.ts";
import { composeMirrors } from "./compose-agents-vm-mirrors.ts";
import { composeOwnerSecrets } from "./compose-agents-vm-secrets.ts";
import {
  composeVmStatus,
  guardedLaunch,
  relayGateOf,
  resourceHostOf,
  skewOf,
} from "./compose-agents-vm-status.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  type AgentRuntimeBackend,
  type AgentFilesPort,
  createFilesDelivery,
  type ClaudeTokenStore,
  createImageEntries,
  createAgentRuntime,
  createGateway,
  createLaunchTokens,
  createProcessBackend,
  layoutOf,
  type MirrorHooks,
  relayListenOf,
  type BundleSkew,
  type RelayChild,
  type RelayLink,
  type VmSpec,
  type VmStatus,
} from "./modules/agent-vm/index.ts";
import type { AgentVmLink } from "./modules/agents/index.ts";
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
  >;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The daemon's environment: the relay child's allowlist is cut from it. */
  readonly env: NodeJS.ProcessEnv;
  /** The database is read-only: a mirror's notice and taint wait (RT-42). */
  readonly readOnly: boolean;
  /** The owner's Claude token (host and vm modes keep it; only vm mode has a relay to push it to). */
  readonly claudeToken: ClaudeTokenStore;
  /** The agent file store: its trash is purged and swept with the agent's disk. */
  readonly agentFiles?: AgentFilesPort | undefined;
}

/** What a test, or a later task, supplies to the composition. */
export interface AgentsVmSeams {
  /** `PAP_TEST_AGENT_RUNTIME=process`: how the guest starts (J1 wires the real entry). */
  readonly process?: { guestEntry: string; execArgv: readonly string[]; imageAgentSource: string };
  /** Tests only: replaces the process backend; it learns the gateway's address when asked. */
  readonly backend?: (gatewayAddress: () => { host: string; port: number }) => AgentRuntimeBackend;
  /** Tests only: replaces the daemon's mirrors of the VM session files (T9b). */
  readonly mirrors?: MirrorInputs;
  /** The image tag an agent's VM starts with (T14b's image policy replaces the test tag). */
  readonly imageTagOf?: (agentId: string) => string;
  /** `"off"`: no relay child (unit tests of other things); a `fork`: the test's own child, told where the relay would listen. Default: the real `pap-relay`. */
  readonly relay?: "off" | { fork(listen: string): RelayChild };
  /** The Kata backend's seams (a fake pap-vmd, T17's migration flag); the Kata backend is used when no test backend is. */
  readonly kata?: KataSeams;
  /** Resolves when the bridge address exists (pap0): the relay is started after it (AVM-P10). Default: at once. */
  readonly bridgeReady?: () => Promise<void>;
  /** Tests only: told of every VM the backend starts and stops (a second open reuses the VM; a crash restarts it). */
  readonly observe?: {
    started?(spec: VmSpec): void;
    stopped?(agentId: string, taskKey: string | null): void;
    /** Every launch's grant (the Kata bed looks for its relay key inside the VM). */
    granted?(grant: { launchId: string; agentId: string; relayKey: string }): void;
  };
  /** Tests only: handed the composition once it is built (the int beds stop a VM or wait for the relay through it). */
  readonly expose?: (vm: AgentsVm) => void;
  readonly bundleSkew?: BundleSkew; // tests only: replaces the stale-bundle check
  readonly proxy?: VmProxySeams; // tests only: the VMs' proxy network seams
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
  /** Where the runtime's crash pause goes (RT-40): the agents' registry and Inbox, which are built after this. Until then it is logged. */
  bindCrashPause(handler: (agentId: string) => void): void;
  bindRefusals: ReturnType<typeof composeVmProxy>["bindRefusals"];
}

const TEST_IMAGE_TAG = `pap-agent-agent-${"0".repeat(64)}`;

const notBound = (): never => {
  throw new PapError("internal");
};

/**
 * Agents run in VMs (T8a): the launch tokens, the gateway, the runtime and the agents' launcher. The gateway listens before this
 * returns (RT-35), and the boot `stopAll` runs before any spawn (RT-42). No usable stack (no pap-vmd, a held port): it composes on
 * loopback with an unusable status, and nothing is stopped.
 */
export async function composeAgentsVm(
  core: AgentsVmCore,
  closers: Array<{ readonly name: string; close(): void | Promise<void> }>,
  seams: AgentsVmSeams = {},
): Promise<AgentsVm> {
  const { config, clock, logger } = core;
  warnAgentsRuntimeIgnored(config, logger);
  // A test backend, else the test process backend, else Kata through pap-vmd.
  if (seams.backend === undefined && config.testAgentRuntime === "process") {
    if (seams.process === undefined) throw new Error("the process backend needs the guest seam");
    if (config.testProviderScript === null)
      throw new Error("PAP_TEST_AGENT_RUNTIME needs the provider script");
  }
  const agentsLogger = logger.child({ module: "agent-vm" });
  const ownerSecrets = composeOwnerSecrets({
    home: config.home,
    piAgentDir: config.piAgentDir,
    logger: agentsLogger,
  });
  const lateHolder: { late: AgentsVmDerived | null } = { late: null };
  const notice = (agentId: string, text: string): void =>
    lateHolder.late
      ? lateHolder.late.notify(agentId, text)
      : agentsLogger.warn("agent_vm_notice_unbound", { agentId });
  const kata =
    seams.backend === undefined && config.testAgentRuntime !== "process"
      ? composeKata(
          { home: config.home, piAgentDir: config.piAgentDir, clock, logger: agentsLogger, ownerSecrets },
          kataSeamsOf(config, seams.kata),
          notice,
        )
      : null;
  // R34: the gateway listens on pap0's address (pap-vmd makes it). No pap-vmd: loopback, an unusable status, no failed boot.
  const bridgeSeen = kata ? await awaitBridge(kata, agentsLogger) : true;
  const tokens = createLaunchTokens();
  // AVM-P8: the gateway reads the image of a launch through the runtime, which exists after it (no cycle).
  let imageOf: AgentRuntime["imageOf"] = () => null;
  const gateway = createGateway({ tokens, clock, logger: agentsLogger, imageOf: (id) => imageOf(id) });
  const onBridge = (bridgeSeen && kata?.gatewayBind) || null;
  const { bind, port, down: unbound } = await listenGateway(gateway, kata !== null, onBridge, agentsLogger);
  let down = unbound;
  const address = () => ({ host: bind.host, port });
  let proxyPort = 0; // set once the proxy listens (process mode: loopback)
  try {
    const guest = seams.process;
    const real =
      seams.backend?.(address) ??
      kata?.backend ??
      createProcessBackend({
        testSwitch: config.testAgentRuntime,
        papHome: config.home,
        guestEntry: guest?.guestEntry ?? "",
        execArgv: guest?.execArgv ?? [],
        imageAgentSource: guest?.imageAgentSource ?? "",
        gatewayAddress: address,
        proxyAddress: () => ({ host: "127.0.0.1", port: proxyPort }),
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
    const proxy = composeVmProxy({
      clock,
      logger: agentsLogger,
      bind: down ? undefined : kata?.proxyBind,
      late: () => lateHolder.late,
      seams: seams.proxy,
      closers,
    });
    const relay = composeRelay({
      clock,
      logger: agentsLogger,
      env: core.env,
      piHostEntry: config.piHostEntry,
      piHostExecArgv: config.piHostExecArgv,
      piAgentDir: config.piAgentDir,
      testProviderScript: config.testProviderScript,
      claudeToken: core.claudeToken,
      ownerSecrets,
      bridgeAddress: kata !== null && !down,
      relay: down ? "off" : seams.relay,
      relayExecArgv: seams.relayExecArgv,
      bridgeReady: seams.bridgeReady ?? (kata ? () => kata.bridgeReady() : undefined),
      late: () => lateHolder.late,
    });
    const imageEntries = kata?.entries ?? createImageEntries(agentsLogger);
    const layoutBackend = kata ? "kata" : "process";
    let crashPause: (agentId: string) => void = (agentId) =>
      agentsLogger.error("agent_vm_crash_pause_unwired", { agentId });
    const delivery = createFilesDelivery({ files: core.agentFiles, clock, logger: agentsLogger });
    const runtime = createAgentRuntime({
      backend,
      gateway,
      tokens,
      clock,
      logger: agentsLogger,
      memoryCapMb: config.agentsMemoryMaxMb,
      idleMs: config.workerIdleMs,
      layout: (spec) => layoutOf(layoutBackend, config.home, spec),
      // Each in its own try (M3): a throw of the relay must not leave the proxy with a stale address.
      onLaunch: (grant) =>
        eachOwnTry(agentsLogger, "agent_vm_launch_hook_failed", grant.launchId, [
          () => relay?.grant(grant),
          () => proxy.launched(grant),
          () => seams.observe?.granted?.(grant),
        ]),
      onLaunchEnd: (launchId) =>
        eachOwnTry(agentsLogger, "agent_vm_launch_end_hook_failed", launchId, [
          () => relay?.revoke(launchId),
          () => proxy.ended(launchId),
        ]),
      onCrashPause: (agentId) => crashPause(agentId),
      notifyCapacity: () => {},
      deliverFiles: delivery.start,
      deliverAgain: delivery.again,
    });
    delivery.live(runtime);
    imageOf = runtime.imageOf;
    const vmStatus = composeVmStatus(core, kata?.client ?? null, runtime, {
      ...seams.kata,
      down: () => down,
    });
    if (!down) await runtime.stopAll();
    proxyPort = await startProxy(proxy, kata !== null, agentsLogger);
    down ||= proxyPort === 0; // a bound listener never answers port 0
    const { own, mirrors, bindHooks } = composeMirrors({
      mirrors: seams.mirrors,
      home: config.home,
      minFreeDiskMb: config.minFreeDiskMb,
      clock,
      logger: agentsLogger,
    });
    own?.start();
    if (own) closers.push({ name: "agent_mirrors", close: () => own.close() });
    if (relay && !down) {
      closers.push({ name: "agent_relay", close: () => relay.stop() });
      void relay.start().catch((error: unknown) =>
        agentsLogger.error("relay_start_failed", {
          err: error,
          ...(kata
            ? {
                listen: relayListenOf(false),
                hint: "the relay listens on the bridge address that pap-vmd makes (pap0): check pap-vmd and its bridge",
              }
            : {}),
        }),
      );
    }
    closers.push({
      name: "agent_vm",
      close: async () => {
        try {
          if (!down) await runtime.stopAll();
        } finally {
          await gateway.close();
        }
      },
    });
    const agentLink = composeAgentsLink({
      runtime,
      client: kata?.client ?? null,
      require: () => vmStatus.status.require(),
      stopVm: (agentId, taskKey) => (kata ? kata.backend.stop(agentId, taskKey) : Promise.resolve()),
      papHome: config.home,
      clock,
      logger: agentsLogger,
      forget: (agentId) => (kata ? kata.images.forget(agentId) : imageEntries.forget(agentId)),
      files: core.agentFiles,
    });
    closers.push({ name: "agent_trash_sweep", close: agentLink.stopSweep });
    if (kata) closers.push({ name: "agent_image_upgrades", close: kata.startUpgrades() });
    const vmLayoutOf = (row: SessionRow): VmLayout | null =>
      row.agentId === undefined
        ? null
        : layoutOf(layoutBackend, config.home, { agentId: row.agentId, taskKey: taskKeyOf(row) });
    const baseLaunch = createVmLaunch({
      runtime,
      papHome: config.home,
      layoutOf: vmLayoutOf,
      joinLaunch: proxy.join,
      imageTagOf: seams.imageTagOf ?? (kata ? kata.imageTagOf : () => TEST_IMAGE_TAG),
      mirrors,
      recheck: (ownerId, agentId) =>
        lateHolder.late ? lateHolder.late.agentOpen(ownerId, agentId) : notBound(),
      logger: agentsLogger,
      toImageEntries: (agentId, image, sources) => imageEntries.toImage(agentId, image, sources),
      packageSources: (ids) => (lateHolder.late ? lateHolder.late.sourcesOf(ids) : notBound()),
      // AVM-E15, process backend only: the scripted provider is copied into the VM's folder and the init names that path.
      ...(kata === null && seams.backend === undefined && config.testProviderScript !== null
        ? { copyProviderScript: scriptCopier(config.testProviderScript) }
        : {}),
    });
    const composed: AgentsVm = {
      runtime,
      launch: guardedLaunch(
        baseLaunch,
        vmStatus.status,
        kata && relay && !down ? relayGateOf(relay, clock) : undefined,
        seams.bundleSkew ?? (kata ? skewOf(kata.images, agentsLogger) : undefined),
      ),
      vmLayoutOf,
      mirrors,
      bindMirrorHooks: bindHooks,
      bindLate(late) {
        vmStatus.bindAgents(late.agents);
        lateHolder.late = bindAgentsVmLate(
          {
            clock,
            logger: agentsLogger,
            closers,
            relay,
            claudeToken: core.claudeToken,
            readOnly: core.readOnly,
            bindMirrorHooks: bindHooks,
            bindTaint: proxy.bindTaint,
          },
          late,
        );
      },
      relay,
      status: vmStatus.status,
      resourceHost: resourceHostOf(config),
      checkPackages: (ids) => (lateHolder.late ? lateHolder.late.checkPackages(ids) : notBound()),
      gatewayPort: port,
      proxyPort,
      agentLink: agentLink.link,
      bindCrashPause: (handler) => void (crashPause = handler),
      bindRefusals: proxy.bindRefusals,
    };
    seams.expose?.(composed);
    return composed;
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
