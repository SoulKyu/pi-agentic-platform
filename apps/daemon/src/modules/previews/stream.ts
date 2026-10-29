import { boxKey, type PreviewsEvent, type StreamName } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { PreviewRegistry } from "./registry.ts";

const SNAPSHOT_LIMIT = 256;
/** A service that says the same thing again inside this window is not sent again (UX2-R31). */
const REPEAT_MS = 1_000;

export interface PreviewsStream {
  /** Stops publishing; the hub's snapshot provider stays (it answers from the registry as it is). */
  stop(): void;
}

/**
 * The `previews` stream (UX2-R31): the key is the owner's id, so a snapshot and every event reach the box owner only. The
 * snapshot is the owner's services in their own boxes (at most 256), empty without a registry (no VM stack). A `service` event
 * is sent on each change and, unchanged, at most once a second.
 */
export function createPreviewsStream(deps: {
  readonly hub: {
    publish(stream: StreamName, key: string, event: unknown): void;
    registerSnapshot(stream: StreamName, provider: (key: string) => unknown): void;
  };
  readonly registry: Pick<PreviewRegistry, "all" | "onChange"> | null;
  readonly clock: Pick<Clock, "now">;
}): PreviewsStream {
  const { hub, registry, clock } = deps;
  hub.registerSnapshot("previews", (ownerId) => ({
    type: "snapshot",
    services: registry?.all(ownerId).slice(0, SNAPSHOT_LIMIT) ?? [],
  }));
  /** The last thing said of each service, dropped with its `removed`: at most the services that exist. */
  const last = new Map<string, { json: string; at: number }>();
  const off = registry?.onChange((event: PreviewsEvent, ownerId) => {
    if (event.type === "removed") {
      last.delete(`${boxKey(event.box)}/${event.name}`);
      hub.publish("previews", ownerId, event);
      return;
    }
    if (event.type !== "service") return;
    const key = `${boxKey(event.service.box)}/${event.service.name}`;
    const json = JSON.stringify(event.service);
    const now = clock.now();
    const before = last.get(key);
    if (before !== undefined && before.json === json && now - before.at < REPEAT_MS) return;
    last.set(key, { json, at: now });
    hub.publish("previews", ownerId, event);
  });
  return { stop: () => off?.() };
}
