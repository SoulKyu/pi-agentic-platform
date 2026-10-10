/** The most a worker string may carry into a record or a log line: the daemon never trusts more (R66). */
export const MAX_WORKER_TEXT = 2000;

export const clipText = (text: string): string => text.slice(0, MAX_WORKER_TEXT);

/** The message of a failure, clipped. */
export const messageOf = (error: unknown): string =>
  clipText(error instanceof Error ? error.message : String(error));

/** The message of a failure as one log line: line breaks would let a message forge the lines around it. */
export const logLineOf = (error: unknown): string =>
  messageOf(error).replace(/\s*[\r\n\p{Zl}\p{Zp}]+\s*/gu, " ");
