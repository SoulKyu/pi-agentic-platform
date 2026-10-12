import { PapError, type Caller } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

const STEP_UP_MS = 5 * 60_000;
const MAX_MARKS = 1024;

export function requireStepUp(caller: Caller, now: number): void {
  if (caller.kind !== "session" || caller.stepUpUntil <= now) throw new PapError("step_up_required");
}

/** Browser sessions that confirmed the password lately, by id hash; insertion-ordered, the oldest dropped at the cap. */
export function createStepUps(clock: Clock) {
  const marks = new Map<string, number>();
  return {
    mark(idHash: string): void {
      marks.delete(idHash);
      marks.set(idHash, clock.now() + STEP_UP_MS);
      if (marks.size > MAX_MARKS) marks.delete(marks.keys().next().value as string);
    },
    until: (idHash: string): number => marks.get(idHash) ?? 0,
    forget(idHash: string): void {
      marks.delete(idHash);
    },
    size: (): number => marks.size,
  };
}
