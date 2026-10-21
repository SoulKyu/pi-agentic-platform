import { PapError } from "@pap/contracts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";

/** What the daemon logs of a worker's output or error text, counted from the end for output (R66, R102). */
export const LOG_CHARS = 2000;
/** An event name an extension error may show to the user; anything else is left out, never cut. */
export const SAFE_EVENT_NAME = /^[a-z][a-z0-9_:.-]{0,63}$/;

/** What a user may read of an extension's path: a package or file name made of plain characters, at most 64 long. */
const SAFE_EXTENSION_LABEL = /^[A-Za-z0-9@][\w@.-]*(\/[\w.-]+)?$/;

/**
 * The short name of the extension a path points at: the package under the last `node_modules/` (scope included), else the
 * file name. Undefined when it is not made of plain characters: the caller then says nothing of the path.
 */
export function extensionLabelOf(path: string): string | undefined {
  const inline = /^<inline:([^<>]+)>$/.exec(path);
  const parts = (inline?.[1] ?? path).split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf("node_modules");
  const scoped = at >= 0 && parts[at + 1]?.startsWith("@") === true;
  const label =
    at >= 0 && at + 1 < parts.length ? parts.slice(at + 1, at + (scoped ? 3 : 2)).join("/") : parts.at(-1);
  return label !== undefined && label.length <= 64 && SAFE_EXTENSION_LABEL.test(label) ? label : undefined;
}

export const clip = (text: string): string =>
  text.length > LOG_CHARS ? `${text.slice(0, LOG_CHARS)}…` : text;

// The end of what the worker printed, not the start: that is where it says why it stopped. Exactly LOG_CHARS at
// most, marker included, so that the logger's own clip (which keeps the start) leaves it alone.
export function outputTailOf(handle: Pick<WorkerHandle, "outputTail">): string {
  const tail = handle.outputTail();
  return tail.length > LOG_CHARS ? `…${tail.slice(-(LOG_CHARS - 1))}` : tail;
}

/** The stable code of a failure, for a log line; anything that is not a `PapError` is `unknown`. */
export const codeOf = (error: unknown): string => (error instanceof PapError ? error.code : "unknown");
