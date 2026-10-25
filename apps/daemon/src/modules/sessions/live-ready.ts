import { MAX_ID_CHARS } from "../../kernel/text.ts";
import { PapError, type ReadyRecord } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { outputTailOf } from "./worker-text.ts";

/** Fork to `ready` takes about 0.7 s (S1): a worker that has not said so after this is stuck, not slow. */
export const READY_TIMEOUT_MS = 30_000;

export const knownId = (id: unknown): string | null =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS ? id : null;

export interface WaitReadyContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly handle: WorkerHandle;
  /** Runs once, when the worker says `ready`, before the wait resolves. */
  readonly onReady: (record: ReadyRecord) => void;
}

/** Moved out of `live-session.ts` as is: the worker's `ready`, or a stuck or exited worker. */
export function waitReady(context: WaitReadyContext): Promise<ReadyRecord> {
  const { clock, logger, handle, onReady } = context;
  return new Promise<ReadyRecord>((resolve, reject) => {
    const timer = clock.setTimeout(() => {
      off();
      logger.warn("worker_not_ready", { output: outputTailOf(handle) });
      void handle.stop();
      reject(new PapError("worker_failed"));
    }, READY_TIMEOUT_MS);
    const off = handle.onRecord((record) => {
      if (record.type !== "ready") return;
      off();
      clock.clearTimeout(timer);
      onReady(record);
      resolve(record);
    });
    void handle.exited.then(() => {
      clock.clearTimeout(timer);
      reject(new PapError("worker_failed"));
    });
  });
}
