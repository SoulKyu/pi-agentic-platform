import { createFakeClock } from "../kernel/clock.ts";
import { createLogger, type Logger } from "../kernel/logger.ts";

/** A logger that keeps what it is asked to log, as parsed JSON lines, so a test can read what reached the log. */
export function captureLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock: createFakeClock(),
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}
