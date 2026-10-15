import type { Clock } from "./clock.ts";
import type { Logger } from "./logger.ts";

const LOG_EVERY_MS = 60_000;
const lastLogged = new WeakMap<Logger, Map<string, number>>();

/**
 * Runs the body of a timer callback so that nothing escapes it (M10R150): a throw or a rejected promise is logged as
 * `<name>_failed`, at most once a minute per name and logger, and never reaches the event loop. The caller re-arms its
 * next tick in a `finally`. Never rejects.
 */
export async function guardTimer(
  logger: Logger,
  name: string,
  work: () => void | Promise<void>,
  clock: Pick<Clock, "now"> = { now: Date.now },
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const at = clock.now();
    const names = lastLogged.get(logger) ?? new Map<string, number>();
    lastLogged.set(logger, names);
    const previous = names.get(name);
    if (previous !== undefined && at - previous < LOG_EVERY_MS) return;
    names.set(name, at);
    logger.error(`${name}_failed`, { err: error });
  }
}
