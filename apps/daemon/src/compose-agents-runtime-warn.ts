import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";

/** `PAP_AGENTS_RUNTIME` no longer chooses anything: a unit that still sets it is told once at boot, whatever the value. */
export function warnAgentsRuntimeIgnored(
  config: Pick<Config, "agentsRuntimeSet">,
  logger: Pick<Logger, "warn">,
): void {
  if (config.agentsRuntimeSet)
    logger.warn("agents_runtime_ignored", {
      message: "PAP_AGENTS_RUNTIME is gone: agents always run in microVMs",
    });
}
