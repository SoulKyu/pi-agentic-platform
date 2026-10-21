import type { Logger } from "./kernel/logger.ts";

/** Runs each step in its own try (M3): a throw is logged and never skips the steps after it. */
export function eachOwnTry(
  logger: Pick<Logger, "error">,
  event: string,
  launchId: string,
  steps: ReadonlyArray<() => void>,
): void {
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      logger.error(event, { err: error, launchId });
    }
  }
}
