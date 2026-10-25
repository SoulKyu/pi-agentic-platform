import { startOfLocalDay } from "./days.ts";
import type { RunTracker } from "./observer.ts";
import type { RunsStore } from "./store.ts";

/**
 * A member's whole spend of the owner's money today (M14, RT-02): every run of the owner billed `api` or `unknown`, the
 * interactive ones included (the automation's `spentSince` counts only task and resume runs), finished and in flight. A
 * run through the member's own Claude token is billed `subscription` and costs the owner nothing. `ownerTimeZone` is the
 * OWNER's zone, never the member's writable one, so the member cannot restart their day.
 */
export function memberSpent(
  deps: {
    readonly store: Pick<RunsStore, "spentApiSince">;
    readonly tracker: Pick<RunTracker, "liveApiSpent">;
  },
  ownerId: string,
  now: number,
  ownerTimeZone: string | null,
): number {
  return (
    deps.store.spentApiSince(ownerId, startOfLocalDay(now, ownerTimeZone)) +
    deps.tracker.liveApiSpent(ownerId)
  );
}
