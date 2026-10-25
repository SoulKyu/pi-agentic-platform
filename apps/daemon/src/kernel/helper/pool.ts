import { type ChildProcess, fork } from "node:child_process";
import { tmpdir } from "node:os";
import { DaemonToHelper, type ErrorCode, helperErrorCode, PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { workerEnv } from "../supervisor/env.ts";
import { classifyExit, type WorkerExit } from "../supervisor/exit.ts";
import { killLadder } from "../supervisor/kill-ladder.ts";
import { releaseGroup, signalGroup, trackGroup } from "../supervisor/process-group.ts";
import {
  buildRunRecord,
  checkedDeadline,
  clipForLog,
  createTail,
  HELPER_MAX_EVENTS,
  HELPER_MAX_PROMPTS,
  readHelperRecord,
} from "./helper-io.ts";

/** After the helper exits, how long to wait for its last records and output before reporting the exit. */
export const STDIO_DRAIN_MS = 500;
/** What a failed run logs of the helper's output: the end of it, clipped to 2 KB. */
const LOG_TAIL_CHARS = 2048;
/** Reads that may wait for a free slot; the next one is refused `pi_busy`. */
export const HELPER_QUEUE_MAX = 16;
/** How long a read waits for a slot before it is refused `pi_busy`; its own deadline starts when it runs. */
export const HELPER_QUEUE_WAIT_MS = 30_000;
/** Ops whose output the helper masks line by line before it reaches stderr; any other op's tail stays out of the log. */
const DEFAULT_TAIL_OPS: ReadonlySet<string> = new Set(["skills.install"]);

export interface HelperPoolStatus {
  readonly active: number;
  readonly max: number;
  readonly waiting: number;
}

export interface HelperPoolOptions {
  readonly entry: string;
  readonly execArgv: readonly string[];
  /** The daemon's environment: `workerEnv` strips `PAP_*` and `NODE_OPTIONS` before a helper sees it. */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly agentDir: string;
  readonly papHome: string;
  /** Added after the strip (tests set `PAP_TEST_PROVIDER` here). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly max: number;
  /** Told after every change of the counts (a run starts, ends, queues, leaves the queue). No ids. */
  readonly onChange?: (status: HelperPoolStatus) => void;
  /** Ops whose output tail a failure may log (default: `skills.install` only; tests name their own op). */
  readonly tailOps?: ReadonlySet<string>;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface HelperRunOptions {
  /** The run is killed and rejects `timeout` when it has not answered by then. */
  readonly deadlineMs: number;
  /** The project folder the operation is about. */
  readonly cwd?: string;
  readonly onEvent?: (event: unknown) => void;
  readonly onPrompt?: (promptId: string, prompt: unknown) => void;
}

export interface HelperHandle {
  /** Rejects `timeout`, `helper_failed` or the mapped code of a failed op. The result is the op's, unparsed. */
  readonly done: Promise<unknown>;
  /** True when the prompt was open and the answer was handed to the helper. */
  answer(promptId: string, value: string | null): boolean;
  /** Tells the helper to stop, and ends it if it does not. */
  cancel(): void;
}

export interface CountedHelperPool extends HelperPool {
  status(): HelperPoolStatus;
}

export interface HelperPool {
  /**
   * Starts at once while there is room. When the pool is full the call waits in a FIFO of at most 16 for at most 30 s (its
   * deadline starts when it runs): the handle is then deferred (`answer` is false, `cancel` leaves the queue). A call with
   * `onPrompt` (a sign-in flow) never waits, and a full queue or a timed-out wait is `PapError("pi_busy")`.
   */
  run(op: string, params: unknown, options: HelperRunOptions): HelperHandle;
  active(): number;
  stopAll(): Promise<void>;
}

interface Queued {
  readonly op: string;
  readonly params: unknown;
  readonly runOptions: HelperRunOptions;
  readonly reject: (error: PapError) => void;
  readonly resolve: (inner: HelperHandle) => void;
  timer?: TimerHandle;
}

interface Live {
  kill(): Promise<WorkerExit>;
}

const failedRun = (error: PapError): HelperHandle => {
  const done = Promise.reject(error);
  done.catch(() => {});
  return { done, answer: () => false, cancel: () => {} };
};

export function createHelperPool(options: HelperPoolOptions): CountedHelperPool {
  const tailOps = options.tailOps ?? DEFAULT_TAIL_OPS;
  const { clock, logger } = options;
  const live = new Set<Live>();
  const queue: Queued[] = [];
  let closed = false;
  const status = (): HelperPoolStatus => ({ active: live.size, max: options.max, waiting: queue.length });
  const changed = (): void => {
    try {
      options.onChange?.(status());
    } catch (error) {
      logger.warn("helper_listener_failed", { err: error });
    }
  };

  function start(op: string, params: unknown, runOptions: HelperRunOptions): HelperHandle {
    const runRecord = buildRunRecord({
      op,
      agentDir: options.agentDir,
      papHome: options.papHome,
      cwd: runOptions.cwd,
      params,
    });
    const deadlineMs = checkedDeadline(runOptions.deadlineMs);
    let child: ChildProcess;
    try {
      child = fork(options.entry, [], {
        cwd: tmpdir(),
        env: workerEnv(options.baseEnv, { PI_CODING_AGENT_DIR: options.agentDir, ...options.extraEnv }),
        execArgv: [...options.execArgv],
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
      });
    } catch (error) {
      logger.warn("helper_failed", { op, why: "spawn", err: error });
      return failedRun(new PapError("helper_failed"));
    }
    const pid = child.pid;
    if (pid !== undefined && pid > 1) trackGroup(pid);

    const tail = createTail();
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => tail.push(chunk));
      stream?.on("error", () => {});
    }
    let resolveDone: (value: unknown) => void = () => {};
    let rejectDone: (error: PapError) => void = () => {};
    const done = new Promise<unknown>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // The caller observes the rejection through `done`; this keeps one that nobody awaits (stopAll) from being unhandled.
    done.catch(() => {});
    let resolveExited: (exit: WorkerExit) => void = () => {};
    const exited = new Promise<WorkerExit>((resolve) => {
      resolveExited = resolve;
    });

    let settled = false;
    let alive = true;
    let reaped = false;
    let events = 0;
    let prompts = 0;
    let stopping: Promise<WorkerExit> | undefined;
    const timers: { deadline?: TimerHandle; drain?: TimerHandle } = {};
    const open = new Set<string>();

    const send = (record: DaemonToHelper): boolean => {
      if (!alive || !child.connected) return false;
      try {
        child.send(record, (error) => {
          if (error) logger.warn("helper_send_failed", { op, pid, err: error });
        });
        return true;
      } catch (error) {
        logger.warn("helper_send_failed", { op, pid, err: error });
        return false;
      }
    };
    const kill = (): Promise<WorkerExit> => {
      if (!alive) return exited;
      stopping ??= killLadder(
        {
          shutdown: () => void send({ type: "helper_cancel" }),
          signal: (signal) => !reaped && signalGroup(pid, signal, logger),
          exited,
        },
        clock,
      ).then((exit) => {
        if (alive) {
          // Not reaped after SIGKILL and the wait: give the slot back; the group is signalled once more at pool exit.
          logger.error("helper_unkillable", { op, pid });
          finish(exit);
        }
        return exit;
      });
      return stopping;
    };
    const settle = (apply: () => void): boolean => {
      if (settled) return false;
      settled = true;
      if (timers.deadline) clock.clearTimeout(timers.deadline);
      apply();
      return true;
    };
    const fail = (code: ErrorCode, why: string, extra: Record<string, unknown> = {}): void => {
      const first = settle(() => rejectDone(new PapError(code)));
      if (first)
        logger.warn("helper_failed", {
          op,
          pid,
          code,
          why,
          ...(tailOps.has(op) ? { tail: tail.text().slice(-LOG_TAIL_CHARS) } : {}),
          ...extra,
        });
      void kill();
    };
    function finish(exit: WorkerExit): void {
      if (!alive) return;
      alive = false;
      if (timers.drain) clock.clearTimeout(timers.drain);
      if (pid !== undefined) releaseGroup(pid);
      live.delete(entry);
      pump();
      changed();
      if (!settled) fail("helper_failed", "exit", { exit });
      resolveExited(exit);
    }
    const entry: Live = { kill };
    live.add(entry);
    changed();

    child.on("error", (error) => {
      logger.warn("helper_error", { op, pid, err: error });
      if (pid === undefined) finish({ code: null, signal: null, cause: "spawn_failure" });
    });
    child.once("exit", (code, signal) => {
      // The leader is gone: whatever shares its group (a `!cmd` it started) goes with it, and nothing may signal the
      // group again, since its id can be recycled once it is empty.
      signalGroup(pid, "SIGKILL", logger);
      reaped = true;
      if (pid !== undefined) releaseGroup(pid);
      const exit = classifyExit(code, signal);
      // `close` follows once the streams and the channel are drained: a record sent just before the exit is read first.
      timers.drain = clock.setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exit);
      }, STDIO_DRAIN_MS);
      child.once("close", () => finish(exit));
    });
    child.once("disconnect", () => void kill());
    child.on("message", (raw: unknown) => {
      if (!alive || settled) return;
      const read = readHelperRecord(raw);
      if (read.kind !== "record") return fail("helper_failed", read.kind);
      const record = read.record;
      if (record.type === "helper_event") {
        if (++events > HELPER_MAX_EVENTS) return fail("helper_failed", "too_many_events");
        try {
          runOptions.onEvent?.(record.event);
        } catch (error) {
          logger.warn("helper_listener_failed", { op, err: error });
        }
      } else if (record.type === "helper_prompt") {
        if (++prompts > HELPER_MAX_PROMPTS) return fail("helper_failed", "too_many_prompts");
        open.add(record.promptId);
        try {
          runOptions.onPrompt?.(record.promptId, record.prompt);
        } catch (error) {
          logger.warn("helper_listener_failed", { op, err: error });
        }
      } else if (record.ok) {
        settle(() => resolveDone(record.result));
        void kill();
      } else {
        logger.warn("helper_op_failed", {
          op,
          code: record.code,
          detail: clipForLog(record.detail ?? ""),
          ...(tailOps.has(op) ? { tail: tail.text().slice(-LOG_TAIL_CHARS) } : {}),
        });
        settle(() => rejectDone(new PapError(helperErrorCode(record.code))));
        void kill();
      }
    });
    timers.deadline = clock.setTimeout(() => fail("timeout", "deadline"), deadlineMs);
    if (!send(runRecord)) fail("helper_failed", "send");

    return {
      done,
      answer(promptId, value) {
        const record = DaemonToHelper.safeParse({ type: "helper_answer", promptId, value });
        if (!record.success || !open.has(promptId)) return false;
        if (!send(record.data)) return false;
        open.delete(promptId);
        return true;
      },
      cancel: () => void kill(),
    };
  }

  function pump(): void {
    while (!closed && live.size < options.max) {
      const next = queue.shift();
      if (!next) return;
      if (next.timer) clock.clearTimeout(next.timer);
      try {
        next.resolve(start(next.op, next.params, next.runOptions));
      } catch (error) {
        next.reject(error instanceof PapError ? error : new PapError("helper_failed"));
      }
    }
  }

  function enqueue(op: string, params: unknown, runOptions: HelperRunOptions): HelperHandle {
    // Refuse a bad folder or deadline now, as a run that starts at once would, not when it leaves the queue.
    buildRunRecord({ op, agentDir: options.agentDir, papHome: options.papHome, cwd: runOptions.cwd, params });
    checkedDeadline(runOptions.deadlineMs);
    let inner: HelperHandle | undefined;
    let resolveDone: (value: unknown) => void = () => {};
    let rejectDone: (error: PapError) => void = () => {};
    const done = new Promise<unknown>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => {});
    const entry: Queued = {
      op,
      params,
      runOptions,
      reject: rejectDone,
      resolve(handle) {
        inner = handle;
        handle.done.then(resolveDone, rejectDone);
      },
    };
    entry.timer = clock.setTimeout(() => {
      leave(entry);
      rejectDone(new PapError("pi_busy"));
      changed();
    }, HELPER_QUEUE_WAIT_MS);
    queue.push(entry);
    changed();
    return {
      done,
      answer: (promptId, value) => inner?.answer(promptId, value) ?? false,
      cancel() {
        if (inner) return inner.cancel();
        if (leave(entry)) {
          rejectDone(new PapError("helper_failed"));
          changed();
        }
      },
    };
  }
  function leave(entry: Queued): boolean {
    const at = queue.indexOf(entry);
    if (at < 0) return false;
    queue.splice(at, 1);
    if (entry.timer) clock.clearTimeout(entry.timer);
    return true;
  }

  return {
    run(op, params, runOptions) {
      if (closed) throw new PapError("helper_failed");
      if (live.size < options.max) return start(op, params, runOptions);
      if (runOptions.onPrompt !== undefined || queue.length >= HELPER_QUEUE_MAX)
        throw new PapError("pi_busy");
      return enqueue(op, params, runOptions);
    },
    active: () => live.size,
    status,
    async stopAll() {
      closed = true;
      for (const waiter of queue.splice(0)) {
        if (waiter.timer) clock.clearTimeout(waiter.timer);
        waiter.reject(new PapError("helper_failed"));
      }
      changed();
      await Promise.all([...live].map((helper) => helper.kill()));
    },
  };
}
