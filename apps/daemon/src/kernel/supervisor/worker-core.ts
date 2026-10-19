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
import { boundedRecord } from "./worker-io.ts";

export interface WorkerStats {
  /** Records that were not valid worker records. */
  readonly droppedRecords: number;
  /** Responses whose request is gone: it timed out, or the id was never issued. */
  readonly unknownResponses: number;
  /** Record listeners that threw. */
  readonly listenerErrors: number;
  readonly pendingRequests: number;
}

/** What a worker handle does with records, whatever carries them: no process, no socket, no pid. */
export interface WorkerCore {
  /** Feed one raw record from any transport. */
  receive(raw: unknown): void;
  request(
    command: CommandInput,
    timeoutMs: number | undefined,
    send: (record: DaemonToWorker) => boolean,
  ): Promise<ResponseRecord>;
  onRecord(listener: (record: WorkerRecord) => void): () => void;
  /** Fail every pending request with `worker_failed` (the channel is gone). */
  failPending(): void;
  stats(): WorkerStats;
}

// Powers of two: the first drop is logged, then the 2nd, 4th, 8th… so a flood of garbage cannot flood the log.
const worthLogging = (count: number): boolean => (count & (count - 1)) === 0;

interface Pending {
  readonly resolve: (record: ResponseRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: TimerHandle | undefined;
}

export function createWorkerCore(deps: {
  clock: Clock;
  logger: Logger;
  /** Spread into every log line of the core (`{ pid }` for a process worker). */
  label: Record<string, unknown>;
}): WorkerCore {
  const { clock, logger, label } = deps;
  const listeners = new Set<(record: WorkerRecord) => void>();
  const pending = new Map<string, Pending>();
  const stats = { droppedRecords: 0, unknownResponses: 0, listenerErrors: 0 };
  let nextId = 0;

  return {
    receive(raw) {
      const record = parseWorkerRecord(raw);
      if (!record) {
        stats.droppedRecords++;
        if (worthLogging(stats.droppedRecords)) {
          const type = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
          logger.warn("worker_record_dropped", {
            ...label,
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
            logger.warn("worker_response_unknown", { ...label, unknown: stats.unknownResponses });
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
            logger.error("worker_listener_failed", { ...label, failures: stats.listenerErrors, err: error });
          }
        }
      }
    },
    request(command, timeoutMs, send) {
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
    failPending() {
      for (const entry of pending.values()) {
        if (entry.timer) clock.clearTimeout(entry.timer);
        entry.reject(new PapError("worker_failed"));
      }
      pending.clear();
    },
    stats: () => ({ ...stats, pendingRequests: pending.size }),
  };
}
