import type { OverviewStreamEvent } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";

/** A viewer hears at most one tick in this span; a change inside it is told once, when the span ends. */
export const TICK_EVERY_MS = 1000;

const TICK: OverviewStreamEvent = { kind: "changed" };

interface Viewer {
  lastAt: number;
  timer: TimerHandle | null;
}

export interface OverviewTicks {
  /** Something an Overview shows moved: every open viewer is told, coalesced (R2). */
  changed(): void;
  /** A viewer opens the stream (also on a resumed one, which gets no snapshot). A viewer the hub does not hold is dropped at the next tick. */
  open(userId: string): void;
  close(userId: string): void;
  stop(): void;
}

/**
 * The `overview` stream's ticks: a tick carries no data, the client reads `overview.get` once per tick. The first change of a
 * quiet second goes out at once; the rest of that second becomes one trailing tick. Nobody is ticked after the last
 * subscriber left.
 */
export function createOverviewTicks(deps: {
  readonly clock: Clock;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot" | "hasSubscribers" | "onLastSubscriberLeft">;
  readonly logger: Logger;
}): OverviewTicks {
  const { clock, hub, logger } = deps;
  const viewers = new Map<string, Viewer>();

  const drop = (userId: string): void => {
    const viewer = viewers.get(userId);
    if (viewer?.timer) clock.clearTimeout(viewer.timer);
    viewers.delete(userId);
  };

  const send = (userId: string, viewer: Viewer): void => {
    viewer.lastAt = clock.now();
    try {
      hub.publish("overview", userId, TICK);
    } catch (error) {
      // One viewer's failed publish never stops the others (the hub throws before it touches any state).
      logger.warn("overview_tick_failed", { err: error });
    }
  };

  const tell = (userId: string, viewer: Viewer): void => {
    if (viewer.timer) return;
    const wait = viewer.lastAt + TICK_EVERY_MS - clock.now();
    if (wait <= 0) return send(userId, viewer);
    viewer.timer = clock.setTimeout(() => {
      viewer.timer = null;
      if (viewers.get(userId) !== viewer) return;
      if (!hub.hasSubscribers("overview", userId)) return drop(userId);
      send(userId, viewer);
    }, wait);
  };

  hub.registerSnapshot("overview", () => TICK);
  hub.onLastSubscriberLeft("overview", drop);

  return {
    changed() {
      for (const [userId, viewer] of [...viewers]) {
        if (!hub.hasSubscribers("overview", userId)) drop(userId);
        else tell(userId, viewer);
      }
    },
    open(userId) {
      if (!viewers.has(userId)) viewers.set(userId, { lastAt: Number.NEGATIVE_INFINITY, timer: null });
    },
    close: drop,
    stop() {
      for (const userId of [...viewers.keys()]) drop(userId);
    },
  };
}
