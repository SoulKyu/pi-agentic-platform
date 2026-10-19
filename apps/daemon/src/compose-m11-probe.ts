import type { spawn } from "node:child_process";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import { bootEgress } from "./modules/egress/index.ts";
import { createSandboxProbe, removeStaleProbes } from "./kernel/sandbox/probe.ts";

/** What the boot of the sandbox probe reads of the daemon's core. */
interface ProbeCore {
  readonly config: { readonly home: string; readonly bwrapOverride?: string | undefined };
  readonly clock: Clock;
  readonly logger: Logger;
  /** The daemon's environment: the egress proxy's sockets live under `$XDG_RUNTIME_DIR` when it is private (W5-R42). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Tests only: the process spawn of the sandbox probe. */
  readonly probeSpawn?: typeof spawn | undefined;
}

/** The probe runs in the background: a slow or failing bwrap never delays the boot (cross-plan agreement 10, M11R57). */
export function bootSandboxProbe(core: ProbeCore) {
  const probe = createSandboxProbe({
    override: core.config.bwrapOverride,
    clock: core.clock,
    logger: core.logger,
    // The canary folder lives in $PAP_HOME, a folder of the read-only root (W5 carry 5).
    tmp: core.config.home,
    ...(core.probeSpawn ? { spawn: core.probeSpawn } : {}),
  });
  removeStaleProbes(core.config.home, core.logger);
  void probe.recheck();
  return probe;
}

/** The egress proxy (M11R243): production builds the real one (M11R244). */
export const bootAgentEgress = (core: ProbeCore) =>
  bootEgress({
    clock: core.clock,
    logger: core.logger.child({ module: "egress" }),
    papHome: core.config.home,
    runtimeDir: core.env?.["XDG_RUNTIME_DIR"],
  });
