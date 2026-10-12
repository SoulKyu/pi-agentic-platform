import {
  type CommandInput,
  type DaemonToWorker,
  PapError,
  type ResponseRecord,
  type WorkerRecord,
  parseWorkerRecord,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../clock.ts";
import type { WorkerExit } from "../supervisor/exit.ts";
import { WORKER_SHUTDOWN_GRACE_MS } from "../supervisor/kill-ladder.ts";
import { boundedOutbound, requestTimeoutMs, type WorkerHandle } from "../supervisor/worker.ts";

type Reply = Partial<Omit<ResponseRecord, "type" | "id">>;

/**
 * A `WorkerHandle` for tests of the modules that use workers. It follows the real handle where a module can tell:
 * the request timeouts and their codes (`timeout` for a slow answer, `worker_failed` for a dead worker), the
 * `shutdown` record `stop()` sends and the 30 s cap on its grace, the listeners a record is delivered to, and a
 * throwing listener being isolated and counted.
 *
 * What it does not do, so a test must not rely on it:
 * - `stop()` ends the worker at once and cleanly (unless `holdShutdown`, which leaves the exit to `crash`): there is
 *   no ladder, no signal, no process group, and a worker that ignores `shutdown` cannot be modelled.
 * - `exited` resolves when `stop()` or `crash()` is called, not after stdio drains; `outputTail()` is always empty.
 * - There is no bound on records in flight, no `droppedRecords` (only the records you `emit` exist) and no
 *   garbage: every record `emit` is given is already a valid `WorkerRecord` (use `emitRaw` to cross the schema).
 * - `send()` always succeeds while the worker is alive, and `pid` is a constant that is not a process.
 * - Timeouts exist only when you pass `clock`; without one a held request waits until `respond` or `crash`.
 */
export interface FakeWorker extends WorkerHandle {
  /** Every record the daemon sent, as the real handle would have put it on the wire. */
  readonly sent: DaemonToWorker[];
  readonly requests: Array<CommandInput & { id: string }>;
  /** A record from the worker, as the real handle delivers it: nothing once the worker is gone, a listener that throws is isolated. */
  emit(record: WorkerRecord): void;
  /** A record as the worker's process would send it: through `parseWorkerRecord`, counted as dropped when it is refused. */
  emitRaw(raw: unknown): void;
  /** Answers a held request. */
  respond(id: string, reply: Reply): void;
  crash(exit: WorkerExit): void;
  stopped(): boolean;
}

export interface FakeWorkerOptions {
  onSend?(record: DaemonToWorker, worker: FakeWorker): void;
  /** Answers a request at once; return nothing to hold it until `respond`, `crash` or its timeout. */
  reply?(command: CommandInput): Reply | undefined;
  pid?: number;
  /** Gives held requests the real handle's timeout (`requestTimeoutMs(command)` unless the request names one). */
  clock?: Clock;
  /** `stop()` sends `shutdown` and waits: the worker exits only when the test calls `crash`, as a real one does within its grace. */
  holdShutdown?: boolean;
}

interface Held {
  readonly command: string;
  readonly resolve: (record: ResponseRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: TimerHandle | undefined;
}

export function createFakeWorker(options: FakeWorkerOptions = {}): FakeWorker {
  const listeners = new Set<(record: WorkerRecord) => void>();
  const pending = new Map<string, Held>();
  let resolveExit: (exit: WorkerExit) => void = () => {};
  const exited = new Promise<WorkerExit>((resolve) => {
    resolveExit = resolve;
  });
  let alive = true;
  let stopCalled = false;
  let nextId = 0;
  const counts = { droppedRecords: 0, unknownResponses: 0, listenerErrors: 0 };
  const release = (id: string): Held | undefined => {
    const held = pending.get(id);
    if (!held) return undefined;
    pending.delete(id);
    if (held.timer) options.clock?.clearTimeout(held.timer);
    return held;
  };
  const finish = (exit: WorkerExit) => {
    if (!alive) return;
    alive = false;
    for (const id of [...pending.keys()]) release(id)?.reject(new PapError("worker_failed"));
    resolveExit(exit);
  };
  const answer = (id: string, reply: Reply, command?: string) => {
    const held = release(id);
    if (!held) {
      counts.unknownResponses++;
      return;
    }
    held.resolve({ type: "response", id, command: command ?? held.command, success: true, ...reply });
  };
  const worker: FakeWorker = {
    pid: options.pid ?? 4242,
    exited,
    sent: [],
    requests: [],
    send(record) {
      if (!alive) return false;
      const sent = boundedOutbound(record);
      worker.sent.push(sent);
      options.onSend?.(sent, worker);
      return true;
    },
    request(command, timeoutMs = requestTimeoutMs(command)) {
      const id = `r${++nextId}`;
      worker.requests.push({ ...command, id } as CommandInput & { id: string });
      if (!alive) return Promise.reject(new PapError("worker_failed"));
      const reply = options.reply?.(command);
      if (reply)
        return Promise.resolve({ type: "response", id, command: command.type, success: true, ...reply });
      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs === undefined
            ? undefined
            : options.clock?.setTimeout(() => {
                pending.delete(id);
                reject(new PapError("timeout"));
              }, timeoutMs);
        pending.set(id, { command: command.type, resolve, reject, timer });
      });
    },
    onRecord(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async stop() {
      stopCalled = true;
      if (alive) worker.send({ type: "shutdown", graceMs: WORKER_SHUTDOWN_GRACE_MS });
      if (!options.holdShutdown) finish({ code: 0, signal: null, cause: "clean" });
      return exited;
    },
    outputTail: () => "",
    stats: () => ({ ...counts, pendingRequests: pending.size }),
    emit(record) {
      if (!alive) return;
      if (record.type === "response") {
        answer(record.id, record, record.command);
        return;
      }
      for (const listener of [...listeners]) {
        try {
          listener(record);
        } catch {
          counts.listenerErrors++;
        }
      }
    },
    emitRaw(raw) {
      const record = parseWorkerRecord(raw);
      if (record) worker.emit(record);
      else if (alive) counts.droppedRecords++;
    },
    respond(id, reply) {
      if (!pending.has(id)) throw new Error(`no pending request ${id}`);
      answer(id, reply);
    },
    crash: (exit) => finish(exit),
    stopped: () => stopCalled,
  };
  return worker;
}
