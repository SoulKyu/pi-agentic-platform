import { type ChildProcess, fork, spawn } from "node:child_process";
import type { CommandInput, DaemonToWorker, ResponseRecord, WorkerRecord } from "@pap/contracts";
import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { classifyExit, type WorkerExit } from "./exit.ts";
import { killLadder, WORKER_SHUTDOWN_GRACE_MS } from "./kill-ladder.ts";
import { releaseGroup, signalGroup, trackGroup } from "./process-group.ts";
import type { WorkerScope } from "./scope.ts";
import { createWorkerCore, type WorkerStats } from "./worker-core.ts";
import { boundedOutbound, createTail, failedHandle, requestTimeoutMs } from "./worker-io.ts";

export { killAllWorkerGroups } from "./process-group.ts";
export type { WorkerStats } from "./worker-core.ts";
export {
  boundedOutbound,
  clipWorkerString,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_SHUTDOWN_GRACE_MS,
  MAX_WORKER_STRING,
  OUTPUT_TAIL_BYTES,
  requestTimeoutMs,
} from "./worker-io.ts";

/** Records handed to the channel and not yet written: a worker that stopped reading cannot grow the queue. */
export const MAX_OUTBOUND_IN_FLIGHT = 1024;
/** After a worker exits, how long to wait for its last output and records before reporting the exit. */
export const STDIO_DRAIN_MS = 500;
/** The longest an exit report waits for the scope to be read and stopped. */
export const REAP_TIMEOUT_MS = 3000;
export interface SpawnWorkerOptions {
  readonly entry: string;
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Launch through a systemd scope instead of a plain fork; the scope is reaped once the worker has exited. */
  readonly scope?: WorkerScope;
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
  /** A VM worker only (R23): where the daemon keeps its session file, the mirror; null until it is open. */
  piFile?(): string | null;
}

export function spawnWorker(options: SpawnWorkerOptions): WorkerHandle {
  const { clock, logger } = options;
  let child: ChildProcess;
  try {
    child = options.scope
      ? spawn(
          options.scope.launch.command,
          [...options.scope.launch.args, process.execPath, ...options.execArgv, options.entry],
          {
            cwd: options.cwd,
            env: { ...options.env, ...options.scope.launch.env },
            detached: true,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            serialization: "json",
          },
        )
      : fork(options.entry, [], {
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
  const core = createWorkerCore({ clock, logger, label: { pid } });
  let alive = true;
  // The leader has been reaped: its pid, which is also its group id, may belong to someone else from now on.
  let reaped = false;
  let inFlight = 0;
  let stopping: Promise<WorkerExit> | undefined;

  let resolveExited: (exit: WorkerExit) => void = () => {};
  const exited = new Promise<WorkerExit>((resolve) => {
    resolveExited = resolve;
  });
  const finish = (exit: WorkerExit): void => {
    if (!alive) return;
    alive = false;
    if (pid !== undefined) releaseGroup(pid);
    core.failPending();
    resolveExited(exit);
  };

  // The exit is reported once the scope has been read and stopped (bounded), so the cgroup is empty when the session hears of it.
  let reported = false;
  const report = (exit: WorkerExit): void => {
    if (reported) return;
    reported = true;
    const scope = options.scope;
    if (!scope) return finish(exit);
    let done = false;
    const settle = (oomKilled: boolean): void => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      finish(oomKilled ? { ...exit, cause: "oom" } : exit);
    };
    const timer = clock.setTimeout(() => {
      logger.warn("worker_scope_reap_slow", { unit: scope.unit });
      settle(false);
    }, REAP_TIMEOUT_MS);
    scope.reap(exit).then(
      ({ oomKilled }) => settle(oomKilled),
      (error: unknown) => {
        logger.warn("worker_scope_reap_failed", { unit: scope.unit, err: error });
        settle(false);
      },
    );
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
      report(exit);
    }, STDIO_DRAIN_MS);
    child.once("close", () => {
      clock.clearTimeout(timer);
      report(exit);
    });
  });
  child.once("disconnect", () => {
    // No answer can come any more, and the worker can no longer be told to stop: fail what waits and take it down.
    core.failPending();
    if (alive) void stop();
  });
  child.on("message", (raw: unknown) => {
    if (alive) core.receive(raw);
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
        // A scope still kills everything in its cgroup; without one this is a plain finish.
        report(exit);
        // One answer: what `exited` resolves with once the scope has been reaped (or the reap gave up).
        return exited;
      }
      return exit;
    });
    return stopping;
  }

  return {
    pid,
    exited,
    send,
    request: (command, timeoutMs = requestTimeoutMs(command)) => core.request(command, timeoutMs, send),
    onRecord: core.onRecord,
    stop,
    outputTail: tail.text,
    stats: core.stats,
  };
}
