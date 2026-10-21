import { randomBytes } from "node:crypto";
import { FILE_CHUNK_BYTES, type HomeResult, PapError } from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { AgentFiles } from "./agent-files.ts";
import type { VmSpec } from "./runtime.ts";

/** A chunk the worker has not answered after this long is lost: the delivery fails instead of waiting for ever. */
export const HOME_PUT_TIMEOUT_MS = 30_000;
type Answer = z.infer<typeof HomeResult>;
type Frame =
  | { type: "home_put"; id: string; path: string; offset: number; data: string; last: boolean }
  | { type: "home_remove"; id: string; path: string };

/** The class of a failure, never a path: a file name is the owner's, and the log is not. */
const refused = (): PapError => new PapError("worker_failed");

/**
 * Deletes the removed paths from the worker's home, then writes the owner's imported files (sub-project 2, spec 7). Removals go
 * first and every refusal is only counted: revoking a credential never waits on a file the agent made unwritable (a link or a
 * folder in its way). One frame at a time: the next goes out when the worker has answered the one before (as the inbox does), so
 * the wire's backlog stays at one chunk. The worker checks every path again and never follows a link out of the home.
 * `onRemoved` hears each path the worker confirmed. Rejects (`worker_failed`) at once on a timeout or a worker that left, and
 * at the end when any frame was refused; what was done stays.
 */
export async function deliverAgentFiles(
  handle: WorkerHandle,
  files: ReadonlyArray<{ readonly path: string; readonly bytes: Buffer }>,
  removals: readonly string[],
  options: { readonly clock: Clock; readonly onRemoved?: (path: string) => void },
): Promise<void> {
  const { clock } = options;
  let gone = false;
  let abort: (() => void) | undefined;
  void handle.exited.then(() => {
    gone = true;
    abort?.();
  });

  const exchange = (frame: Frame): Promise<Answer> =>
    new Promise<Answer>((resolve, reject) => {
      if (gone) return reject(refused());
      let off: () => void = () => {};
      const timer = clock.setTimeout(() => settle(refused()), HOME_PUT_TIMEOUT_MS);
      const settle = (outcome: Answer | PapError): void => {
        off();
        clock.clearTimeout(timer);
        abort = undefined;
        if (outcome instanceof PapError) reject(outcome);
        else resolve(outcome);
      };
      abort = () => settle(refused());
      off = handle.onRecord((record) => {
        if (record.type === "home_result" && record.id === frame.id) settle(record);
      });
      if (!handle.send(frame)) settle(refused());
    });

  let refusals = 0;
  for (const path of removals) {
    const answer = await exchange({ type: "home_remove", id: randomBytes(16).toString("hex"), path });
    if (answer.ok) options.onRemoved?.(path);
    else refusals++;
  }
  for (const file of files) {
    const id = randomBytes(16).toString("hex");
    let offset = 0;
    do {
      const end = Math.min(offset + FILE_CHUNK_BYTES, file.bytes.length);
      const data = file.bytes.subarray(offset, end).toString("base64");
      const frame: Frame = {
        type: "home_put",
        id,
        path: file.path,
        offset,
        data,
        last: end >= file.bytes.length,
      };
      if (!(await exchange(frame)).ok) {
        refusals++;
        break;
      }
      offset = end;
    } while (offset < file.bytes.length);
  }
  if (refusals > 0) throw refused();
}

/** What the composition hands over: the delivery reads and confirms, the trash is purged and swept with the disk. */
export type AgentFilesPort = Pick<
  AgentFiles,
  "read" | "pendingRemovals" | "delivered" | "onChange" | "purgeTrash" | "sweepTrash"
>;

/**
 * The delivery of an agent's files. `start` runs at every VM start (all files, all pending removals). Only the thread VM
 * confirms the removals: a task VM has its own home, and the thread VM's may still hold the file. `live` writes one imported
 * path, or applies the pending removals, to the thread VM's worker the moment the owner changes a file; with no live worker
 * the next start, or the next new worker of that VM, does it. A failed delivery is logged and retried the same way.
 */
export function createFilesDelivery(deps: {
  files: AgentFilesPort | undefined;
  clock: Clock;
  logger: Logger;
}) {
  const { files, clock, logger } = deps;
  /** One delivery at a time per agent: a start and a live change never interleave, and each reads the store when it runs. */
  const queues = new Map<string, Promise<unknown>>();
  const inQueue = <T>(agentId: string, task: () => Promise<T>): Promise<T> => {
    const result = (queues.get(agentId) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => {});
    queues.set(agentId, tail);
    void tail.then(() => {
      if (queues.get(agentId) === tail) queues.delete(agentId);
    });
    return result;
  };
  const run = async (
    agentId: string,
    handle: WorkerHandle,
    only: string | null,
    confirm: boolean,
  ): Promise<void> => {
    if (files === undefined) return;
    const removals = files.pendingRemovals(agentId);
    const present = (await files.read(agentId)).filter((file) => only === null || file.path === only);
    const removed: string[] = [];
    try {
      await deliverAgentFiles(handle, present, removals, { clock, onRemoved: (path) => removed.push(path) });
    } finally {
      if (confirm && removed.length > 0) files.delivered(agentId, removed);
    }
  };
  /** Agents whose thread VM missed a change (no worker to send it to, or a refused one): the next new worker gets everything. */
  const dirty = new Set<string>();
  const full = (spec: VmSpec, handle: WorkerHandle): Promise<void> =>
    inQueue(spec.agentId, async () => {
      try {
        await run(spec.agentId, handle, null, spec.kind === "thread");
      } catch (error) {
        if (spec.kind === "thread") dirty.add(spec.agentId);
        throw error;
      }
      if (spec.kind === "thread") dirty.delete(spec.agentId);
    });
  return {
    start: full,
    /** A later worker of a VM that had its start delivery: it gets the files only when a change was missed. */
    again: (spec: VmSpec, handle: WorkerHandle): Promise<void> =>
      spec.kind === "thread" && dirty.has(spec.agentId) ? full(spec, handle) : Promise.resolve(),
    live(runtime: { threadWorker(agentId: string): WorkerHandle | undefined }): void {
      files?.onChange((agentId, path) => {
        void inQueue(agentId, async () => {
          const handle = runtime.threadWorker(agentId);
          if (handle === undefined) {
            dirty.add(agentId);
            return;
          }
          try {
            await run(agentId, handle, path, true);
          } catch (error) {
            dirty.add(agentId);
            throw error;
          }
        }).catch((error: unknown) => {
          logger.warn("agent_files_live_delivery_failed", { agentId, err: error });
        });
      });
    },
  };
}
