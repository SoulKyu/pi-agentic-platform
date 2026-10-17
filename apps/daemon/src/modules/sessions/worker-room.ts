import { PapError } from "@pap/contracts";
import type { LiveSession } from "./live-session.ts";

/**
 * One worker stays free for the owner's own sessions (M10R154). `keepOneFree` is checked inside `launch`, after the agent
 * gate's await, for the launches in `keepFreeFor` (the runner's and the agent port's): nothing awaits between the check and
 * the spawn, so two concurrent starts cannot both take the last worker.
 */
export function createWorkerRoom(deps: {
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly starting: ReadonlySet<LiveSession>;
  readonly limits: { readonly maxWorkers: number; readonly minFreeMemMb: number };
  readonly freeMemMb: () => number;
  /** The service is shutting down: no worker starts. */
  readonly closing: () => boolean;
}) {
  const keepFreeFor = new Set<string>();
  /** Ids whose cold launch must come up sandboxed (owner a5, M11R214): held by the automation port until its prompt settles. */
  const sandboxedOnly = new Set<string>();
  const keepOneFree = (): void => {
    const used = deps.live.size + deps.starting.size;
    if (used + 2 > deps.limits.maxWorkers)
      throw new PapError("capacity", { workers: { used, max: deps.limits.maxWorkers } });
  };
  /** A new worker would not take the cap or the free-memory floor (R9). */
  const checkCapacity = (): void => {
    const used = deps.live.size + deps.starting.size;
    if (deps.closing() || used >= deps.limits.maxWorkers || deps.freeMemMb() < deps.limits.minFreeMemMb)
      throw new PapError("capacity", { workers: { used, max: deps.limits.maxWorkers } });
  };
  return { keepFreeFor, sandboxedOnly, keepOneFree, checkCapacity };
}
export type WorkerRoom = ReturnType<typeof createWorkerRoom>;
