import { LANE_LIMITS, type LaneView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

type LaneNotice = LaneView["notices"][number];
export type LaneNoticeKind = LaneNotice["kind"];

export interface LaneNotices {
  /** Adds a notice (counts only, never names); the lane is published after it. */
  add(laneId: string, kind: LaneNoticeKind, count?: number): void;
  list(laneId: string): LaneNotice[];
  forget(laneId: string): void;
}

/**
 * Lane notices live in memory only (M9R115): the newest 8 of each lane, gone at a restart. A display buffer, never
 * security state; the map holds at most one entry per lane that had a notice since the daemon started.
 */
/** Lanes that keep notices; the oldest lane's are dropped past this (open lanes are at most 64 per owner). */
const MAX_LANES = 1024;

export function createLaneNotices(clock: Clock, changed: (laneId: string) => void): LaneNotices {
  const byLane = new Map<string, LaneNotice[]>();
  return {
    add(laneId, kind, count) {
      const list = byLane.get(laneId) ?? [];
      list.push({ kind, at: clock.now(), count: count ?? null });
      while (list.length > LANE_LIMITS.notices) list.shift();
      byLane.delete(laneId);
      byLane.set(laneId, list);
      if (byLane.size > MAX_LANES) byLane.delete(byLane.keys().next().value as string);
      changed(laneId);
    },
    list: (laneId) => [...(byLane.get(laneId) ?? [])],
    forget: (laneId) => void byLane.delete(laneId),
  };
}
