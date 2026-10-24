import type { BoxRef } from "@pap/contracts";
import type { AgentsVm } from "./compose-agents-vm.ts";
import type { VmProxySeams } from "./compose-agents-vm-proxy.ts";
import type { KataSeams } from "./compose-agents-vm-kata.ts";
import type { AgentRuntimeBackend, BundleSkew, RelayChild, VmSpec } from "./modules/agent-vm/index.ts";
import type { MirrorInputs } from "./modules/sessions/index.ts";

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
    stopped?(box: BoxRef, taskKey: string | null): void;
    /** Every launch's grant (the Kata bed looks for its relay key inside the VM). */
    granted?(grant: { launchId: string; box: BoxRef; relayKey: string }): void;
  };
  /** Tests only: handed the composition once it is built (the int beds stop a VM or wait for the relay through it). */
  readonly expose?: (vm: AgentsVm) => void;
  readonly bundleSkew?: BundleSkew; // tests only: replaces the stale-bundle check
  readonly proxy?: VmProxySeams; // tests only: the VMs' proxy network seams
  /** The relay child's node flags (default: the workers'); a test whose workers carry the network guard gives its own. */
  readonly relayExecArgv?: readonly string[];
}
