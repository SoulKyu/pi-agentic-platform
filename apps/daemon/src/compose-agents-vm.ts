import { PapError } from "@pap/contracts";
import { composeBoxes, TEST_IMAGE_TAG } from "./compose-boxes.ts";
import { scriptCopier } from "./compose-agents-vm-script.ts";
import { composeAgentsLink } from "./compose-agents-vm-agents.ts";
import { composeVmProxy } from "./compose-agents-vm-proxy.ts";
import { composeRelay } from "./compose-agents-vm-relay.ts";
import type { AgentsVmSeams } from "./compose-agents-vm-seams.ts";

export type { AgentsVmSeams } from "./compose-agents-vm-seams.ts";
export type { AgentsVm, AgentsVmCore } from "./compose-agents-vm-types.ts";
import { type AgentsVmDerived, bindAgentsVmLate } from "./compose-agents-vm-late.ts";
import { awaitBridge, composeKata, listenGateway } from "./compose-agents-vm-kata.ts";
import { kataSeamsOf, startProxy } from "./compose-agents-vm-socket.ts";
import { warnAgentsRuntimeIgnored } from "./compose-agents-runtime-warn.ts";
import { eachOwnTry } from "./compose-agents-vm-hooks.ts";
import { composeMirrors } from "./compose-agents-vm-mirrors.ts";
import { composeOwnerSecrets } from "./compose-agents-vm-secrets.ts";
import { composeVmStatus, resourceHostOf } from "./compose-agents-vm-status.ts";
import { composeLaunchGate } from "./compose-agents-vm-gate.ts";
import type { AgentsVm, AgentsVmCore } from "./compose-agents-vm-types.ts";
import { ownerIdOf } from "./modules/auth/index.ts";
import {
  type AgentRuntime,
  type AgentRuntimeBackend,
  createFilesDelivery,
  createImageEntries,
  createAgentRuntime,
  createAgentStart,
  createGateway,
  createLaunchRegistry,
  createLaunchTokens,
  createProcessBackend,
  observedBackend,
  relayListenOf,
} from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";
import { createVmLaunch } from "./modules/sessions/index.ts";

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
    ownerId: () => (core.db ? ownerIdOf(core.db) : null),
    ...(core.githubLive ? { githubLive: core.githubLive } : {}),
  });
  let helperStatus: () => { active: number; max: number; waiting: number } = () => ({
    active: 0,
    max: 0,
    waiting: 0,
  });
  let liveVms: AgentRuntime["liveVms"] = () => 0;
  const launches = createLaunchRegistry({
    clock,
    logger: agentsLogger,
    soleVm: (box) => liveVms(box) <= 1,
    helpers: () => helperStatus(),
    ...(core.hub ? { hub: core.hub } : {}),
    ...(core.db ? { db: core.db } : {}),
  });
  const lateHolder: {
    late: AgentsVmDerived | null;
    agents: Pick<AgentsPort, "get"> | null;
  } = { late: null, agents: null };
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
        githubOrigin: config.testGithubOrigin ?? null,
        ...(guest?.env ? { guestEnv: guest.env } : {}),
        clock,
        logger: agentsLogger,
      });
    const backend: AgentRuntimeBackend = observedBackend(real, seams.observe);
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
    const boxes = composeBoxes(
      config.home,
      agentsLogger,
      kata?.images ?? null,
      seams.imageTagOf,
      core.claudeToken,
    );
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
      layout: boxes.layoutOfSpec,
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
      onCrashPause: (box) => boxes.crashPause(box, crashPause),
      notifyCapacity: () => {},
      deliverFiles: delivery.start,
      deliverAgain: delivery.again,
    });
    delivery.live(runtime);
    imageOf = runtime.imageOf;
    liveVms = runtime.liveVms;
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
    closers.push({ name: "launches", close: () => launches.close() });
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
      stopVm: (box, taskKey) => (kata ? kata.backend.stop(box, taskKey) : Promise.resolve()),
      papHome: config.home,
      clock,
      logger: agentsLogger,
      forget: (agentId) => (kata ? kata.images.forget(agentId) : imageEntries.forget(agentId)),
      files: core.agentFiles,
    });
    closers.push({ name: "agent_trash_sweep", close: agentLink.stopSweep });
    if (kata) closers.push({ name: "agent_image_upgrades", close: kata.startUpgrades() });
    const { vmLayoutOf } = boxes;
    const imageTagOf = seams.imageTagOf ?? (kata ? kata.imageTagOf : () => TEST_IMAGE_TAG);
    const baseLaunch = createVmLaunch({
      runtime,
      papHome: config.home,
      layoutOf: vmLayoutOf,
      launches,
      joinLaunch: (launchId, sessionId, project) =>
        proxy.join(
          launchId,
          sessionId,
          project !== undefined && lateHolder.late?.taintedNow(project.ownerId, sessionId) === true,
        ),
      imageTagOf,
      mirrors,
      recheck: (ownerId, agentId) =>
        lateHolder.late ? lateHolder.late.agentOpen(ownerId, agentId) : notBound(),
      logger: agentsLogger,
      ...boxes.launchDeps,
      toImageEntries: (agentId, image, sources) => imageEntries.toImage(agentId, image, sources),
      packageSources: (ids) => (lateHolder.late ? lateHolder.late.sourcesOf(ids) : notBound()),
      // AVM-E15, process backend only: the scripted provider is copied into the VM's folder and the init names that path.
      ...(kata === null && seams.backend === undefined && config.testProviderScript !== null
        ? { copyProviderScript: scriptCopier(config.testProviderScript) }
        : {}),
    });
    const { launch: guarded, gate } = composeLaunchGate({
      baseLaunch,
      status: vmStatus.status,
      kata,
      relay: relay && !down ? relay : null,
      clock,
      logger: agentsLogger,
      bundleSkew: seams.bundleSkew,
      late: () => lateHolder.late,
      launches,
    });
    const startAgent = createAgentStart({
      runtime,
      launches,
      gate,
      imageTagOf,
      agentOf(ownerId, agentId) {
        const record = lateHolder.agents?.get(ownerId, agentId) ?? null;
        if (record === null || record.input === null) return null;
        return { input: record.input, paused: record.paused, quarantined: record.quarantinedAt !== null };
      },
      recheck: (ownerId, agentId) =>
        lateHolder.late ? lateHolder.late.agentOpen(ownerId, agentId) : notBound(),
      disabled: (box) => (lateHolder.late ? lateHolder.late.boxDisabled(box) : notBound()),
    });
    const composed: AgentsVm = {
      runtime,
      launches,
      launch: guarded,
      boxStack: {
        backend: kata ? "kata" : "process",
        client: kata?.client ?? null,
        gate,
      },
      vmLayoutOf,
      boxes,
      mirrors,
      bindMirrorHooks: bindHooks,
      bindLate(late) {
        boxes.bind(late.boxes ?? null);
        if (late.pi.helpers) {
          const pool = late.pi.helpers;
          helperStatus = () => pool.status();
        }
        late.pi.bindHelperOwners?.(() => launches.subscribedOwners());
        vmStatus.bindAgents(late.agents);
        lateHolder.agents = late.agents;
        core.launchStop?.bind({
          launches,
          stopBox: (box) => runtime.stop(box),
          logger: agentsLogger,
        });
        core.launchLog?.bind({
          projectOwner: (projectId) => late.boxes?.source.box(projectId)?.ownerId ?? null,
          buildLog: (boxId) => (kata ? kata.images.buildLog(boxId) : Promise.resolve([])),
        });
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
            launchRaised: proxy.raised,
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
      startAgent,
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
