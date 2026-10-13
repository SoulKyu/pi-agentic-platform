/** The most a worker string may carry into a record or a log line: the daemon never trusts more (R66). */
export const MAX_WORKER_TEXT = 2000;

export const clipText = (text: string): string => text.slice(0, MAX_WORKER_TEXT);

/** The message of a failure, clipped. */
export const messageOf = (error: unknown): string =>
  clipText(error instanceof Error ? error.message : String(error));

/** The message of a failure as one log line: line breaks would let a message forge the lines around it. */
export const logLineOf = (error: unknown): string =>
  messageOf(error).replace(/\s*[\r\n\p{Zl}\p{Zp}]+\s*/gu, " ");

/** The class of a failure as a short identifier: what a log line may say of an error whose message can quote a secret. */
export const errorClass = (error: unknown): string =>
  (error instanceof Error ? error.constructor.name : typeof error)
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 64) || "unknown";
