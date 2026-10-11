import type { PapError } from "@pap/contracts";
import { createFakeClock } from "../../../kernel/clock.ts";
import { createLogger, type Logger } from "../../../kernel/logger.ts";

/** The error code a promise rejects with, or null when it resolves. */
export const codeOf = (promise: Promise<unknown>): Promise<string | null> =>
  promise.then(
    () => null,
    (error: PapError) => error.code,
  );

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
