import { join } from "node:path";
import { AGENT_NET, type AgentInput, PapError, VmdHealth } from "@pap/contracts";
import { nodeBaseImage } from "./cli/vm/assets.ts";
import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntimeBackend,
  createImageEntries,
  createKataBackend,
  createKataImages,
  createVmdClient,
  type ImageEntries,
  type KataImages,
  type KnownSecrets,
  type OwnerSecretsCollector,
  VMD_SOCKET,
  type VmdClient,
} from "./modules/agent-vm/index.ts";

/** pap-vmd's root-owned bundle (`sudo pap vm setup` installs it); the base image's tag follows its bytes. */
const BUNDLE_ROOT = "/opt/pap-vm/agent-bundle";
const BRIDGE_TRIES = 30;
const BRIDGE_RETRY_MS = 2_000;
/** The base is looked at for its weekly rebuild this often (one rebuild a week: the policy decides). */
const UPGRADE_CHECK_MS = 3_600_000;

/** What a test, or a later task, supplies for the Kata backend. */
export interface KataSeams {
  /** A fake pap-vmd. Default: the real client on `socket`. */
  readonly client?: VmdClient;
  readonly socket?: string;
  readonly bundleRoot?: string;
  readonly nodeImage?: string;
  /** Tests: replaces the collector of the owner's secrets (T15b) with a plain list. */
  readonly knownSecrets?: () => KnownSecrets;
  /** `/dev/kvm` exists. Default: looks at the machine. */
  readonly kvm?: () => boolean;
  /** Where the gateway listens (tests: loopback). Default: the bridge's host address (R34). */
  readonly gatewayBind?: { readonly host: string; readonly port: number };
}

export interface KataParts {
  readonly client: VmdClient;
  readonly images: KataImages;
  readonly entries: ImageEntries;
  readonly backend: AgentRuntimeBackend;
  readonly gatewayBind: { readonly host: string; readonly port: number };
  /** Where the VMs' egress proxy listens: the bridge's host address and the proxy port; loopback, any port, when a test moves the gateway. */
  readonly proxyBind: { readonly host: string; readonly port: number };
  /** Resolves when pap0 is up and pap's firewall table is loaded; rejects when pap-vmd is not there or either never comes. */
  bridgeReady(): Promise<void>;
  /** The image tag an agent's VM starts with, built first when it must be. */
  imageTagOf(agentId: string, input: AgentInput, kind: "thread" | "isolated"): Promise<string>;
  /** The weekly rebuild of the base: told hourly, builds once a week. Returns the way to stop. */
  startUpgrades(): () => void;
}

const refusedSecrets = async (): Promise<never> => {
  throw new Error("no collector of the owner's secrets");
};

/**
 * Outside tests: the Kata backend, over pap-vmd's socket. The pieces are built here, the composition of
 * the daemon (`compose-agents-vm.ts`) decides when to use them.
 */
export function composeKata(
  core: {
    readonly home: string;
    readonly piAgentDir: string;
    readonly clock: Clock;
    readonly logger: Logger;
    /** The collector the profile build calls each time (`compose-agents-vm-secrets.ts`); without one the build refuses. */
    readonly ownerSecrets?: OwnerSecretsCollector;
  },
  seams: KataSeams,
  notice: (agentId: string, text: string) => void,
): KataParts {
  const { clock, logger } = core;
  const client = seams.client ?? createVmdClient(seams.socket ?? VMD_SOCKET, clock);
  const entries = createImageEntries(logger, {
    file: join(core.home, "vm", "image-entries.json"),
    strict: true,
  });
  const images = createKataImages({
    client,
    clock,
    logger,
    papHome: core.home,
    agentDir: core.piAgentDir,
    bundleRoot: seams.bundleRoot ?? BUNDLE_ROOT,
    nodeImage: seams.nodeImage ?? nodeBaseImage(),
    weekFile: join(core.home, "vm", "base-week"),
    secrets: seams.knownSecrets ?? core.ownerSecrets ?? refusedSecrets,
    entries,
    notice,
  });
  let ready: Promise<void> | null = null;
  async function waitForBridge(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      // A pap-vmd that is not there throws at once (the boot goes on unusable); only a bridge still being made is waited for.
      const health = VmdHealth.safeParse(await client.request({ op: "vmd.health" }));
      if (health.success && health.data.bridge && health.data.ruleset) return;
      if (attempt >= BRIDGE_TRIES) throw new PapError("sandbox_unavailable");
      await clock.sleep(BRIDGE_RETRY_MS);
    }
  }
  return {
    client,
    images,
    entries,
    backend: createKataBackend({
      client,
      images,
      logger,
      notice,
    }),
    gatewayBind: seams.gatewayBind ?? { host: AGENT_NET.host, port: AGENT_NET.gatewayPort },
    proxyBind: seams.gatewayBind
      ? { host: seams.gatewayBind.host, port: 0 }
      : { host: AGENT_NET.host, port: AGENT_NET.proxyPort },
    bridgeReady() {
      ready ??= waitForBridge().catch((error: unknown) => {
        ready = null;
        throw error;
      });
      return ready;
    },
    imageTagOf: (agentId, input, kind) => images.resolve(agentId, input.systemPackages, kind),
    startUpgrades() {
      let timer: TimerHandle | null = null;
      const tick = (): void => {
        void images.upgradeBaseIfDue();
        timer = clock.setTimeout(tick, UPGRADE_CHECK_MS);
      };
      timer = clock.setTimeout(tick, UPGRADE_CHECK_MS);
      return () => {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
      };
    },
  };
}

/**
 * The boot waits for pap0 and pap's firewall table. A pap-vmd that is not there or never gets them is not a boot failure: false,
 * and the composition falls back to loopback with an unusable status (`sandbox_unavailable` on every agent call).
 */
export async function awaitBridge(kata: Pick<KataParts, "bridgeReady">, logger: Logger): Promise<boolean> {
  try {
    await kata.bridgeReady();
    return true;
  } catch (error) {
    logger.warn("agent_vm_bridge_unavailable", {
      err: error,
      hint: "agents are unavailable: run `sudo pap vm setup`, start pap-vmd, then restart pap",
    });
    return false;
  }
}

/**
 * R34: the gateway listens on pap0's address when there is one (`onBridge`). Without it, or when the port is held (pap0 is made by
 * pap-vmd; another process may hold the port), it listens on loopback and `down` is true: the status is unusable, the boot goes on.
 */
export async function listenGateway(
  gateway: { listen(host: string, port: number): Promise<{ port: number }> },
  kata: boolean,
  onBridge: { host: string; port: number } | null,
  logger: Logger,
): Promise<{ bind: { host: string; port: number }; port: number; down: boolean }> {
  if (onBridge !== null) {
    try {
      return { bind: onBridge, ...(await gateway.listen(onBridge.host, onBridge.port)), down: false };
    } catch (error) {
      if (!kata) throw error;
      logger.error("agent_vm_gateway_unavailable", {
        err: error,
        hint: `the gateway cannot listen on ${onBridge.host}:${onBridge.port}: run \`sudo pap vm setup\` and start pap-vmd, or stop the process that holds the port; agents are unavailable until pap restarts`,
      });
    }
  }
  const bind = { host: "127.0.0.1", port: 0 };
  return { bind, ...(await gateway.listen(bind.host, bind.port)), down: kata };
}
