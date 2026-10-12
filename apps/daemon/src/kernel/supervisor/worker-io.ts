import { type CommandInput, type DaemonToWorker, PapError, type WorkerRecord } from "@pap/contracts";
import type { WorkerExit } from "./exit.ts";
import type { WorkerHandle } from "./worker.ts";

/** Stdout and stderr of a worker are kept only as a tail: a worker that floods them cannot grow the daemon. */
export const OUTPUT_TAIL_BYTES = 8 * 1024;
/** A worker that never answers must not leave a request pending forever (every command but `prompt`). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** `shutdown.graceMs` is honoured by the worker as given: the daemon never asks for more than this. */
export const MAX_SHUTDOWN_GRACE_MS = 30_000;
/** Worker-origin strings are untrusted: bounded before they are logged or handed on (R66). */
export const MAX_WORKER_STRING = 2048;

/**
 * How long a command may wait for its answer unless the caller says otherwise. `prompt`, `compact` and `navigate_tree`
 * have none: an extension command answers only when it ends (R38(1)), a compaction waits for the model's summary, and
 * a navigation waits for `session_before_tree` hooks that may ask the user (M2-RT-08); the wait ends with the worker.
 * Naming and export call the model or write a file: two minutes.
 */
const COMMAND_TIMEOUTS: Partial<Record<CommandInput["type"], number | undefined>> = {
  prompt: undefined,
  compact: undefined,
  navigate_tree: undefined,
  auto_name: 120_000,
  export_html: 120_000,
};
export const requestTimeoutMs = (command: CommandInput): number | undefined =>
  command.type in COMMAND_TIMEOUTS ? COMMAND_TIMEOUTS[command.type] : DEFAULT_REQUEST_TIMEOUT_MS;

export const clipWorkerString = (text: string): string =>
  text.length > MAX_WORKER_STRING ? `${text.slice(0, MAX_WORKER_STRING)}…` : text;

/** What the daemon is willing to put on the wire, whoever asked. */
export function boundedOutbound(record: DaemonToWorker): DaemonToWorker {
  return record.type === "shutdown" && record.graceMs > MAX_SHUTDOWN_GRACE_MS
    ? { ...record, graceMs: MAX_SHUTDOWN_GRACE_MS }
    : record;
}

// Worker-origin text reaches the daemon's callers only in these fields.
export function boundedRecord(record: WorkerRecord): WorkerRecord {
  if (record.type === "response" && record.error !== undefined) {
    return { ...record, error: clipWorkerString(record.error) };
  }
  if (record.type === "extension_error") {
    return {
      ...record,
      extensionPath: clipWorkerString(record.extensionPath),
      event: clipWorkerString(record.event),
      error: clipWorkerString(record.error),
    };
  }
  return record;
}

export function createTail() {
  let tail = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      const whole = Buffer.concat([tail, chunk]);
      tail = Buffer.from(whole.subarray(Math.max(0, whole.length - OUTPUT_TAIL_BYTES)));
    },
    text: (): string => tail.toString("utf8"),
  };
}

export function failedHandle(exit: WorkerExit): WorkerHandle {
  const none = { droppedRecords: 0, unknownResponses: 0, listenerErrors: 0, pendingRequests: 0 };
  return {
    pid: undefined,
    exited: Promise.resolve(exit),
    send: () => false,
    request: () => Promise.reject(new PapError("worker_failed")),
    onRecord: () => () => {},
    stop: () => Promise.resolve(exit),
    outputTail: () => "",
    stats: () => none,
  };
}
