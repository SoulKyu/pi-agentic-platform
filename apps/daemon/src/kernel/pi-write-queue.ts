import { PapError } from "@pap/contracts";

/** Writes waiting for Pi's files (one running, the rest queued): a full queue refuses, nothing is dropped. */
export const WRITE_QUEUE_MAX = 8;

export interface PiWriteQueue {
  /** Runs `task` after every earlier one ended; rejects with `capacity` at once when the queue is full. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * The one chain of every write of Pi's own configuration (MC28, MC29): a helper plans from the file it reads, so two
 * overlapping writes would each plan from the same old text and the second would erase the first. The daemon has one
 * agent directory, hence one queue; the composition root creates it once and hands it to every module that writes there.
 */
export function createPiWriteQueue(max: number = WRITE_QUEUE_MAX): PiWriteQueue {
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      if (pending >= max) return Promise.reject(new PapError("capacity"));
      pending += 1;
      const result = tail.then(task);
      tail = result.catch(() => undefined);
      return result.finally(() => {
        pending -= 1;
      });
    },
  };
}
