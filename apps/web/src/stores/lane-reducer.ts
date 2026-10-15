import { LaneStreamEvent, type FanoutView, type LaneView } from "@pap/contracts";

export interface LaneState {
  readonly loaded: boolean;
  /** Why the subscription was refused or failed; null once a snapshot came (like the shell store). */
  readonly failed: string | null;
  /** The owner's lanes that are not archived (creating, active, archiving, failed), by id. */
  readonly lanes: ReadonlyMap<string, LaneView>;
  readonly fanouts: ReadonlyMap<string, FanoutView>;
  /** Archived lanes: the shelf's count; the list itself is paged by `lanes.listArchived`. */
  readonly archived: number;
  /** Events this build could not read (a newer kind, a shape the schema refuses): skipped, never fatal. */
  readonly skipped: number;
}

export const EMPTY_LANES: LaneState = {
  loaded: false,
  failed: null,
  lanes: new Map(),
  fanouts: new Map(),
  archived: 0,
  skipped: 0,
};

/** A lane the tree, the palette and the tabs list: not archived and not being archived. */
export const isLiveLane = (lane: LaneView): boolean =>
  lane.state !== "archived" && lane.state !== "archiving";

export const failLanes = (state: LaneState, code: string): LaneState => ({ ...state, failed: code });

export function reduceLanes(state: LaneState, event: unknown): LaneState {
  const parsed = LaneStreamEvent.safeParse(event);
  if (!parsed.success) return { ...state, skipped: state.skipped + 1 };
  const data = parsed.data;
  switch (data.kind) {
    case "snapshot":
      return {
        loaded: true,
        failed: null,
        lanes: new Map(data.lanes.map((lane) => [lane.id, lane])),
        fanouts: new Map(data.fanouts.map((fanout) => [fanout.id, fanout])),
        archived: data.archived,
        skipped: state.skipped,
      };
    case "lane": {
      const lanes = new Map(state.lanes);
      if (data.lane.state !== "archived") {
        lanes.set(data.lane.id, data.lane);
        return { ...state, lanes };
      }
      // Counted once: only a lane the store held moves from the map to the shelf.
      const held = lanes.delete(data.lane.id);
      return { ...state, lanes, archived: held ? state.archived + 1 : state.archived };
    }
    case "fanout": {
      const fanouts = new Map(state.fanouts);
      fanouts.set(data.fanout.id, data.fanout);
      return { ...state, fanouts };
    }
  }
}
