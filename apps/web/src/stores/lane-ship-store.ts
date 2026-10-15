import type { PrView } from "@pap/contracts";
import { create } from "zustand";

/** What the PR panel and the commit bar must remember when the panel is closed or the tab is left. */
export interface LaneShip {
  /** A pull request creation timed out: it may exist, so only a check is offered until one answers (R105). */
  readonly unknown: boolean;
  /** The pull request a create or a check found, until the lane stream carries it. */
  readonly found: PrView | null;
  /** A push is running: the bar's Push and "Push and create" share this one guard. */
  readonly pushing: boolean;
  /** A creation is running. */
  readonly creating: boolean;
  /** The branch an archive left behind: it outlives the dialog, which the lane stream unmounts with the lane. */
  readonly keptBranch: string | null;
}

const NONE: LaneShip = { unknown: false, found: null, pushing: false, creating: false, keptBranch: null };

interface LaneShipState {
  readonly byLane: Readonly<Record<string, LaneShip>>;
  patch(laneId: string, patch: Partial<LaneShip>): void;
  reset(): void;
}

export const useLaneShipStore = create<LaneShipState>()((set) => ({
  byLane: {},
  patch: (laneId, patch) =>
    set((state) => ({
      byLane: { ...state.byLane, [laneId]: { ...(state.byLane[laneId] ?? NONE), ...patch } },
    })),
  reset: () => set({ byLane: {} }),
}));

export const useLaneShip = (laneId: string): LaneShip =>
  useLaneShipStore((state) => state.byLane[laneId] ?? NONE);

/** Read at the moment of a click, never from a render: two clicks in one tick must see the same answer. */
export const shipOf = (laneId: string): LaneShip => useLaneShipStore.getState().byLane[laneId] ?? NONE;
