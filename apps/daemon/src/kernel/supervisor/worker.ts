import { type ChildProcess, fork } from "node:child_process";
import {
  type CommandInput,
  type DaemonToWorker,
  PapError,
  parseWorkerRecord,
  type ResponseRecord,
  type WorkerRecord,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { classifyExit, type WorkerExit } from "./exit.ts";
import { killLadder, WORKER_SHUTDOWN_GRACE_MS } from "./kill-ladder.ts";
import { releaseGroup, signalGroup, trackGroup } from "./process-group.ts";

export { killAllWorkerGroups } from "./process-group.ts";

/** Stdout and stderr of a worker are kept only as a tail: a worker that floods them cannot grow the daemon. */
export const OUTPUT_TAIL_BYTES = 8 * 1024;
/** A worker that never answers must not leave a request pending forever (every command but `prompt`). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** `shutdown.graceMs` is honoured by the worker as given: the daemon never asks for more than this. */
export const MAX_SHUTDOWN_GRACE_MS = 30_000;
/** Records handed to the channel and not yet written: a worker that stopped reading cannot grow the queue. */
export const MAX_OUTBOUND_IN_FLIGHT = 1024;
/** After a worker exits, how long to wait for its last output and records before reporting the exit. */
export const STDIO_DRAIN_MS = 500;
/** Worker-origin strings are untrusted: bounded before they are logged or handed on (R66). */
export const MAX_WORKER_STRING = 2048;

export interface SpawnWorkerOptions {
  readonly entry: string;
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface WorkerStats {
  /** Records that were not valid worker records. */
  readonly droppedRecords: number;
  /** Responses whose request is gone: it timed out, or the id was never issued. */
  readonly unknownResponses: number;
  /** Record listeners that threw. */
  readonly listenerErrors: number;
  readonly pendingRequests: number;
}

export interface WorkerHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<WorkerExit>;
  /** True when the record was handed to the channel (even if it is backed up); false when the worker is unreachable. */
  send(record: DaemonToWorker): boolean;
  /**
   * Rejects with `PapError("worker_failed")` when the worker is gone (died, refused the record, closed the
   * channel) and with `PapError("timeout")` when it is alive and did not answer in time: `timeoutMs`, else
   * `requestTimeoutMs(command)`. A slow answer is never a dead worker.
   */
  request(command: CommandInput, timeoutMs?: number): Promise<ResponseRecord>;
  onRecord(listener: (record: WorkerRecord) => void): () => void;
  /** Idempotent. Always resolves: the ladder ends with SIGKILL to the worker's whole process group. */
  stop(): Promise<WorkerExit>;
  /** The last bytes of stdout and stderr, at most `OUTPUT_TAIL_BYTES`. */
  outputTail(): string;
  stats(): WorkerStats;
}

/**
 * How long a command may wait for its answer unless the caller says otherwise. A `prompt` has none: an extension
 * command answers only when it ends (R38(1)), possibly after a dialog the user takes minutes to answer, while a
 * plain prompt answers as soon as Pi has classified it. The pending prompt ends with the worker.
 */
export const requestTimeoutMs = (command: CommandInput): number | undefined =>
  command.type === "prompt" ? undefined : DEFAULT_REQUEST_TIMEOUT_MS;

export const clipWorkerString = (text: string): string =>
  text.length > MAX_WORKER_STRING ? `${text.slice(0, MAX_WORKER_STRING)}…` : text;

/** What the daemon is willing to put on the wire, whoever asked. */
export function boundedOutbound(record: DaemonToWorker): DaemonToWorker {
  return record.type === "shutdown" && record.graceMs > MAX_SHUTDOWN_GRACE_MS
    ? { ...record, graceMs: MAX_SHUTDOWN_GRACE_MS }
    : record;
}

// Worker-origin text reaches the daemon's callers only in these fields.
function boundedRecord(record: WorkerRecord): WorkerRecord {
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

// Powers of two: the first drop is logged, then the 2nd, 4th, 8th… so a flood of garbage cannot flood the log.
const worthLogging = (count: number): boolean => (count & (count - 1)) === 0;

function createTail() {
  let tail = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      const whole = Buffer.concat([tail, chunk]);
      tail = Buffer.from(whole.subarray(Math.max(0, whole.length - OUTPUT_TAIL_BYTES)));
    },
    text: (): string => tail.toString("utf8"),
  };
}

function failedHandle(exit: WorkerExit): WorkerHandle {
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

interface Pending {
  readonly resolve: (record: ResponseRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: TimerHandle | undefined;
}

export function spawnWorker(options: SpawnWorkerOptions): WorkerHandle {
  const { clock, logger } = options;
  let child: ChildProcess;
  try {
    child = fork(options.entry, [], {
      cwd: options.cwd,
      env: options.env,
      execArgv: [...options.execArgv],
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
  } catch (error) {
    logger.warn("worker_spawn_failed", { err: error });
    return failedHandle({ code: null, signal: null, cause: "spawn_failure" });
  }
  const pid = child.pid;
  if (pid !== undefined) trackGroup(pid);
  const tail = createTail();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => tail.push(chunk));
    stream?.on("error", () => {});
  }
  const listeners = new Set<(record: WorkerRecord) => void>();
  const pending = new Map<string, Pending>();
  const stats = { droppedRecords: 0, unknownResponses: 0, listenerErrors: 0 };
  let alive = true;
  // The leader has been reaped: its pid, which is also its group id, may belong to someone else from now on.
  let reaped = false;
  let nextId = 0;
  let inFlight = 0;
  let stopping: Promise<WorkerExit> | undefined;

  const failPending = (): void => {
    for (const entry of pending.values()) {
      if (entry.timer) clock.clearTimeout(entry.timer);
      entry.reject(new PapError("worker_failed"));
    }
    pending.clear();
  };
  let resolveExited: (exit: WorkerExit) => void = () => {};
  const exited = new Promise<WorkerExit>((resolve) => {
    resolveExited = resolve;
  });
  const finish = (exit: WorkerExit): void => {
    if (!alive) return;
    alive = false;
    if (pid !== undefined) releaseGroup(pid);
    failPending();
    resolveExited(exit);
  };

  child.on("error", (error) => {
    logger.warn("worker_error", { pid, err: error });
    if (pid === undefined) finish({ code: null, signal: null, cause: "spawn_failure" });
  });
  child.once("exit", (code, signal) => {
    // The leader is gone; whatever shares its group goes with it. Nothing may signal the group after this: while a
    // member lives the id stays taken, but once the group is empty the pid can be recycled.
    signalGroup(pid, "SIGKILL", logger);
    reaped = true;
    if (pid !== undefined) releaseGroup(pid);
    const exit = classifyExit(code, signal);
    // `close` follows once stdout, stderr and the channel are drained: the tail and the records are complete
    // when the exit is reported. A process that kept a pipe open must not hold the report back, nor leak it.
    const timer = clock.setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(exit);
    }, STDIO_DRAIN_MS);
    child.once("close", () => {
      clock.clearTimeout(timer);
      finish(exit);
    });
  });
  child.once("disconnect", () => {
    // No answer can come any more, and the worker can no longer be told to stop: fail what waits and take it down.
    failPending();
    if (alive) void stop();
  });
  child.on("message", (raw: unknown) => {
    if (!alive) return;
    const record = parseWorkerRecord(raw);
    if (!record) {
      stats.droppedRecords++;
      if (worthLogging(stats.droppedRecords)) {
        const type = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
        logger.warn("worker_record_dropped", {
          pid,
          dropped: stats.droppedRecords,
          recordType: typeof type === "string" ? type.slice(0, 64) : typeof raw,
        });
      }
      return;
    }
    if (record.type === "response") {
      const entry = pending.get(record.id);
      if (!entry) {
        stats.unknownResponses++;
        if (worthLogging(stats.unknownResponses)) {
          logger.warn("worker_response_unknown", { pid, unknown: stats.unknownResponses });
        }
        return;
      }
      pending.delete(record.id);
      if (entry.timer) clock.clearTimeout(entry.timer);
      entry.resolve(boundedRecord(record) as ResponseRecord);
      return;
    }
    const bounded = boundedRecord(record);
    // The listeners there were when the record arrived: one that leaves or joins while it is delivered does not
    // change who hears this record.
    for (const listener of [...listeners]) {
      try {
        listener(bounded);
      } catch (error) {
        stats.listenerErrors++;
        if (worthLogging(stats.listenerErrors)) {
          logger.error("worker_listener_failed", { pid, failures: stats.listenerErrors, err: error });
        }
      }
    }
  });

  const send = (record: DaemonToWorker): boolean => {
    if (!alive || !child.connected || inFlight >= MAX_OUTBOUND_IN_FLIGHT) return false;
    inFlight++;
    try {
      // `false` also means "backed up"; the record is queued then, and only a closed channel is a failure.
      const accepted = child.send(boundedOutbound(record), (error) => {
        inFlight--;
        if (error) logger.warn("worker_send_failed", { pid, err: error });
      });
      return accepted || child.connected;
    } catch (error) {
      inFlight--;
      logger.warn("worker_send_failed", { pid, err: error });
      return false;
    }
  };

  function stop(): Promise<WorkerExit> {
    if (!alive) return exited;
    stopping ??= killLadder(
      {
        // The ladder waits longer than the worker is told to: a worker that uses all its grace still beats SIGTERM.
        shutdown: () => {
          send({ type: "shutdown", graceMs: WORKER_SHUTDOWN_GRACE_MS });
        },
        signal: (signal) => !reaped && signalGroup(pid, signal, logger),
        exited,
      },
      clock,
    ).then((exit) => {
      if (alive) {
        // Still not reaped after SIGKILL and the wait: declare it dead so nothing waits on it any longer.
        logger.error("worker_unkillable", { pid });
        finish(exit);
      }
      return exit;
    });
    return stopping;
  }

  return {
    pid,
    exited,
    send,
    request(command, timeoutMs = requestTimeoutMs(command)) {
      const id = `r${++nextId}`;
      return new Promise<ResponseRecord>((resolve, reject) => {
        const timer =
          timeoutMs === undefined
            ? undefined
            : clock.setTimeout(() => {
                pending.delete(id);
                reject(new PapError("timeout"));
              }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        if (!send({ ...command, id } as DaemonToWorker)) {
          pending.delete(id);
          if (timer) clock.clearTimeout(timer);
          reject(new PapError("worker_failed"));
        }
      });
    },
    onRecord(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop,
    outputTail: tail.text,
    stats: () => ({ ...stats, pendingRequests: pending.size }),
  };
}
