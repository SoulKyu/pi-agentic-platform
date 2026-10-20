import { VmdFailure } from "./errors.ts";

/** One agent never queues more than this many operations: a flood from the caller is refused `capacity`. */
export const MAX_QUEUED_PER_AGENT = 64;
/** Joins and starts are bounded by the agents and tags pap-vmd knows; this caps a caller that invents tags. */
const MAX_JOINED = 256;
const MAX_QUEUED_STARTS = 256;

export interface Locks {
  /** RT-33, RT-42: `vm.*` and `disk.*` of one agent run one at a time, in arrival order. */
  withAgent<T>(agentId: string, run: () => Promise<T>): Promise<T>;
  /** AVM-P12: one `nerdctl run` plus `net.attach` at a time, whatever the agent (bridge-port discovery is "the new port"). */
  withStart<T>(run: () => Promise<T>): Promise<T>;
  /** A second `image.build` of a tag already building joins the running one and gets its result. */
  joinBuild<T>(tag: string, run: () => Promise<T>): Promise<T>;
}

interface Queue {
  tail: Promise<void>;
  pending: number;
}

const settle = (): void => undefined;

function enqueue<T>(queues: Map<string, Queue>, key: string, cap: number, run: () => Promise<T>): Promise<T> {
  const queue = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  if (queue.pending >= cap) return Promise.reject(new VmdFailure("capacity"));
  queue.pending += 1;
  queues.set(key, queue);
  const result = queue.tail.then(run);
  queue.tail = result.then(settle, settle);
  return result.finally(() => {
    queue.pending -= 1;
    if (queue.pending === 0) queues.delete(key);
  });
}

export function createLocks(): Locks {
  const agents = new Map<string, Queue>();
  const starts = new Map<string, Queue>();
  const joined = new Map<string, Promise<unknown>>();

  function join<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = joined.get(key);
    if (running) return running as Promise<T>;
    if (joined.size >= MAX_JOINED) return Promise.reject(new VmdFailure("capacity"));
    const started = (async () => run())().finally(() => {
      joined.delete(key);
    });
    joined.set(key, started);
    return started;
  }

  const withAgent: Locks["withAgent"] = (agentId, run) => enqueue(agents, agentId, MAX_QUEUED_PER_AGENT, run);
  return {
    withAgent,
    withStart: (run) => enqueue(starts, "start", MAX_QUEUED_STARTS, run),
    joinBuild: (tag, run) => join(`build:${tag}`, run),
  };
}

export interface RoomDeps {
  readonly freeMb: () => Promise<number>;
  /** `PAP_MIN_FREE_DISK_MB`; 0 leaves only the operation's own need. */
  readonly minFreeMb: number;
}

/** RT-42: `disk_low` when the state folder's file system has less free space than the operation needs plus the floor. */
export function createRoomCheck(deps: RoomDeps): (needMb: number) => Promise<void> {
  return async (needMb) => {
    let free: number;
    try {
      free = await deps.freeMb();
    } catch {
      throw new VmdFailure("disk_low");
    }
    if (free < needMb + deps.minFreeMb) throw new VmdFailure("disk_low");
  };
}
