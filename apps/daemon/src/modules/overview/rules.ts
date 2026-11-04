import {
  MIN_VM_MEMORY_MB,
  OVERVIEW_LIMITS,
  type OverviewActivity,
  type OverviewBox,
  type OverviewState,
} from "@pap/contracts";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";

/** The state words by urgency, most urgent first; `stopped` is the folded strip. */
export const URGENCY: readonly OverviewState[] = ["waiting", "failed", "running", "starting", "stopped"];

/** The card's word (R1): the first fact that holds, in the order of `URGENCY`, else `stopped`. */
export function stateOf(facts: {
  waiting: boolean;
  failed: boolean;
  running: boolean;
  starting: boolean;
}): OverviewState {
  if (facts.waiting) return "waiting";
  if (facts.failed) return "failed";
  if (facts.running) return "running";
  if (facts.starting) return "starting";
  return "stopped";
}

/** By `URGENCY`, then by name; a new array. */
export function sortBoxes(boxes: OverviewBox[]): OverviewBox[] {
  return [...boxes].sort(
    (a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state) || a.name.localeCompare(b.name),
  );
}

/** The start check's own formula (`fitsCapacity`): equality fits. */
export const fitsMb = (usedMb: number, needMb: number, maxMb: number): boolean => usedMb + needMb <= maxMb;

/** No VM of the smallest size fits any more: the band says FULL. */
export const isFull = (usedMb: number, maxMb: number): boolean =>
  !fitsMb(usedMb, MIN_VM_MEMORY_MB + VM_OVERHEAD_MB, maxMb);

/** A member's view of the shared memory: a percentage rounded to the nearest 5, never a figure in GB. */
export function sharedPercent(usedMb: number, maxMb: number): number {
  if (maxMb <= 0) return 0;
  const rounded = Math.round(((usedMb / maxMb) * 100) / 5) * 5;
  return Math.min(100, Math.max(0, rounded));
}

const KIND_ORDER: Record<OverviewActivity["kind"], number> = { thread: 0, session: 1, task: 2 };

/** At most `OVERVIEW_LIMITS.activities` lines (thread, sessions, tasks, each by start) and how many were left out. */
export function capActivities(list: OverviewActivity[]): { activities: OverviewActivity[]; more: number } {
  const sorted = [...list].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.since ?? Number.POSITIVE_INFINITY) - (b.since ?? Number.POSITIVE_INFINITY),
  );
  const activities = sorted.slice(0, OVERVIEW_LIMITS.activities);
  return { activities, more: sorted.length - activities.length };
}
