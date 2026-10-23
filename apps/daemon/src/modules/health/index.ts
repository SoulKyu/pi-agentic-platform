import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { createHealthBuffer } from "./buffer.ts";
import { createHealthEvents, type HealthEventInput, type HealthEvents } from "./events.ts";
import { healthRpc, type HealthRpc } from "./rpc.ts";
import { createHealthStream } from "./stream.ts";

export { healthRpc } from "./rpc.ts";
export type { HealthRpc } from "./rpc.ts";
export { createHealthEvents } from "./events.ts";
export type { HealthEventInput, HealthEvents } from "./events.ts";
export { createHealthBuffer } from "./buffer.ts";

export interface HealthModule {
  /** The daemon's one health bus: every emitter is handed this, never a bus of its own. */
  readonly port: HealthEvents;
  readonly rpc: HealthRpc;
  /** Drops the outbox subscriptions, the stream and the bus-to-buffer link. */
  stop(): void;
}

/**
 * The health module (Task 4): the bus, the buffer it feeds, the `ops` stream over both, and the outbox's own failures.
 * A system effect (`ownerId === null`) has no owner to page: log-only in v1, the outbox already logs it.
 */
export function createHealthModule(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  readonly outbox: Pick<Outbox, "onFailed" | "onOverdue">;
}): HealthModule {
  const buffer = createHealthBuffer({ clock: deps.clock, logger: deps.logger });
  const events = createHealthEvents(deps.logger);
  const offRecord = events.on((input: HealthEventInput) => buffer.record(input));
  const stream = createHealthStream({ buffer, hub: deps.hub, logger: deps.logger });
  const offFailed = deps.outbox.onFailed((failure) => {
    if (failure.ownerId === null) return;
    events.emit({
      ownerId: failure.ownerId,
      kind: "outbox",
      code: "outbox_handler_error",
      sourceRef: { kind: "effect", id: failure.id },
    });
  });
  const offOverdue = deps.outbox.onOverdue((overdue) => {
    if (overdue.ownerId === null) return;
    events.emit({
      ownerId: overdue.ownerId,
      kind: "outbox",
      code: "outbox_handler_overdue",
      sourceRef: { kind: "effect", id: overdue.id },
    });
  });
  return {
    port: events,
    rpc: healthRpc({
      page: (ownerId, params) => buffer.page(ownerId, params.before, params.limit),
    }),
    stop() {
      offFailed();
      offOverdue();
      stream.stop();
      offRecord();
    },
  };
}
