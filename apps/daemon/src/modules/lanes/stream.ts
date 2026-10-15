import type { LaneStreamEvent, LaneView, StreamName } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { LaneNotices } from "./notices.ts";
import type { LaneRow, LanesStore } from "./store.ts";
import { NO_OUTWARD, type Outward, viewOf } from "./view.ts";

/** The part of the stream hub the lane stream uses. */
export interface LaneHub {
  publish(stream: StreamName, key: string, event: unknown): void;
  registerSnapshot(stream: StreamName, provider: (key: string) => unknown): void;
}

export interface LaneStream {
  /** The hub exists once the daemon has built it; events before that are dropped (nothing is subscribed yet). */
  bind(hub: LaneHub): void;
  /** A lane changed: its view goes out once at the end of this tick, however many times it changed. */
  changed(laneId: string): void;
  /** A fan-out group exists or changed: its event goes out at once, before the views of its lanes. */
  fanoutChanged(ownerId: string, fanoutId: string): void;
  snapshot(ownerId: string): Extract<LaneStreamEvent, { kind: "snapshot" }>;
  view(laneId: string): LaneView | undefined;
}

export function createLaneStream(deps: {
  readonly store: LanesStore;
  readonly notices: Pick<LaneNotices, "list">;
  readonly logger: Logger;
  /** The lane's facts; asking may start a background refresh when they are stale (M9R42). */
  readonly facts?: (laneId: string) => LaneView["facts"];
  /** The lane's pull request, forge and remote (Task 14). */
  readonly outward?: (row: LaneRow) => Outward;
  /** The lane holds the most checkpoints it may. */
  readonly checkpointsFull?: (laneId: string) => boolean;
  readonly schedule?: (flush: () => void) => void;
}): LaneStream {
  const { store } = deps;
  const schedule = deps.schedule ?? queueMicrotask;
  let hub: LaneHub | null = null;
  const pending = new Set<string>();
  let armed = false;

  const laneView = (row: LaneRow): LaneView =>
    viewOf(
      row,
      deps.notices.list(row.id),
      row.state === "archived" ? null : (deps.facts?.(row.id) ?? null),
      deps.outward?.(row) ?? NO_OUTWARD,
      deps.checkpointsFull?.(row.id) ?? false,
    );
  const view = (laneId: string): LaneView | undefined => {
    const row = store.get(laneId);
    return row && laneView(row);
  };

  const flush = (): void => {
    armed = false;
    for (const laneId of [...pending]) {
      pending.delete(laneId);
      try {
        const row = store.get(laneId);
        if (row && hub) hub.publish("lane", row.ownerId, { kind: "lane", lane: laneView(row) });
      } catch (error) {
        // One lane that cannot be read or sent must not drop the others; the next change or snapshot says the truth.
        deps.logger.error("lane_publish_failed", { err: error });
      }
    }
  };

  const snapshot = (ownerId: string): Extract<LaneStreamEvent, { kind: "snapshot" }> => {
    // Newest first; the oldest lanes go until the event fits one frame (M2R54). A lane's fan-out goes with it.
    const lanes = store.open(ownerId).map(laneView);
    const archived = store.archivedCount(ownerId);
    const build = (kept: LaneView[]) => {
      const ids = [...new Set(kept.flatMap((lane) => (lane.fanoutId === null ? [] : [lane.fanoutId])))];
      return {
        kind: "snapshot" as const,
        lanes: kept,
        fanouts: store.fanouts(ownerId, ids),
        archived,
        // The oldest lanes go first (`open` is newest first); the flag says the list is not the whole.
        truncated: kept.length < lanes.length,
      };
    };
    let kept = lanes;
    let event = build(kept);
    while (kept.length > 0 && sizeOf(event) > PAGE_BYTES) {
      kept = kept.slice(0, -1);
      event = build(kept);
    }
    return event;
  };

  return {
    bind(next) {
      hub = next;
      next.registerSnapshot("lane", snapshot);
    },
    changed(laneId) {
      pending.add(laneId);
      if (armed) return;
      armed = true;
      schedule(flush);
    },
    fanoutChanged(ownerId, fanoutId) {
      const fanout = store.fanouts(ownerId, [fanoutId])[0];
      if (fanout && hub) hub.publish("lane", ownerId, { kind: "fanout", fanout });
    },
    snapshot,
    view,
  };
}
