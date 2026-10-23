import type { OpsStreamEvent } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { createHealthBuffer } from "./buffer.ts";

/** The `ops` stream over the buffer: a snapshot on subscribe, then each row and its collapses. */
export function createHealthStream(deps: {
  readonly buffer: ReturnType<typeof createHealthBuffer>;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  readonly logger: Logger;
}): { stop(): void } {
  deps.hub.registerSnapshot("ops", (ownerId) => deps.buffer.snapshot(ownerId));
  const stop = deps.buffer.on((change) => {
    const event: OpsStreamEvent =
      change.kind === "event"
        ? { kind: "event", event: change.event }
        : { kind: "collapse", seq: change.seq, ts: change.ts, count: change.count };
    // publish throws before touching any state when the event cannot be serialised: never stop the emitter for that
    try {
      deps.hub.publish("ops", change.ownerId, event);
    } catch (error) {
      deps.logger.warn("health_publish_failed", { kind: change.kind, err: error });
    }
  });
  return { stop };
}
