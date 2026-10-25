import type { PapError, Waiting, WaitingReason } from "@pap/contracts";

/** A task put off until a time, and what it waits for (the board says it). */
export interface PutOff {
  readonly until: number;
  readonly reason: WaitingReason;
  readonly used?: number;
  readonly max?: number;
  /** Builds ahead of it in the image queue. */
  readonly position?: number;
  /** Said on the task only: the admission does not skip it (its owner's full slots hold it back already). */
  readonly passive?: true;
}

/**
 * What a `capacity` refusal waits for (R16): the boxes' memory cap (`memory`, MB) or the worker slots (`workers`); a refusal
 * that counted neither is the slots, without numbers.
 */
export function capacityWait(error: PapError): Pick<PutOff, "reason" | "used" | "max"> {
  if (error.memory) return { reason: "box_memory", used: error.memory.used, max: error.memory.max };
  if (error.workers) return { reason: "session_slots", used: error.workers.used, max: error.workers.max };
  return { reason: "session_slots" };
}

/** The tasks put off, by id. `changed` hears each visible change and each delete, so the board learns what a task waits for. */
export function createPutOffs(changed: (taskId: string) => void): Map<string, PutOff> {
  const map = new Map<string, PutOff>();
  const set = map.set.bind(map);
  const remove = map.delete.bind(map);
  const same = (a: PutOff | undefined, b: PutOff) =>
    a?.reason === b.reason && a.used === b.used && a.max === b.max && a.position === b.position;
  map.set = (id, entry) => {
    const before = map.get(id);
    set(id, entry);
    // Only what the board shows counts: a later next try alone is not told.
    if (!same(before, entry)) changed(id);
    return map;
  };
  map.delete = (id) => {
    const had = remove(id);
    if (had) changed(id);
    return had;
  };
  return map;
}

/** The wire shape of a put-off: numbers and a reason, never a name. */
export function waitingOf(entry: PutOff | undefined): Waiting | null {
  if (entry === undefined) return null;
  return {
    reason: entry.reason,
    ...(entry.used === undefined ? {} : { used: entry.used }),
    ...(entry.max === undefined ? {} : { max: entry.max }),
    ...(entry.position === undefined ? {} : { position: entry.position }),
    nextTryAt: entry.until,
  };
}
