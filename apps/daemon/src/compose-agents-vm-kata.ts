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
  /** Where the gateway listens (tests: loopback). Default: the bridge's host address (R34). */
  readonly gatewayBind?: { readonly host: string; readonly port: number };
}

export interface KataParts {
  readonly client: VmdClient;
  readonly images: KataImages;
  readonly entries: ImageEntries;
  readonly backend: AgentRuntimeBackend;
  readonly gatewayBind: { readonly host: string; readonly port: number };
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
 * `PAP_AGENTS_RUNTIME=vm` outside tests: the Kata backend, over pap-vmd's socket. The pieces are built here, the composition of
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
      // A pap-vmd that is not there fails the boot at once (`unavailable`); only a bridge still being made is waited for.
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
