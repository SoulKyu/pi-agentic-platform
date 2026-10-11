import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";

/** What the daemon logs of a worker's output or error text, counted from the end for output (R66, R102). */
export const LOG_CHARS = 2000;
/** An event name an extension error may show to the user; anything else is left out, never cut. */
export const SAFE_EVENT_NAME = /^[a-z][a-z0-9_:.-]{0,63}$/;

export const clip = (text: string): string =>
  text.length > LOG_CHARS ? `${text.slice(0, LOG_CHARS)}…` : text;

// The end of what the worker printed, not the start: that is where it says why it stopped. Exactly LOG_CHARS at
// most, marker included, so that the logger's own clip (which keeps the start) leaves it alone.
export function outputTailOf(handle: Pick<WorkerHandle, "outputTail">): string {
  const tail = handle.outputTail();
  return tail.length > LOG_CHARS ? `…${tail.slice(-(LOG_CHARS - 1))}` : tail;
}
