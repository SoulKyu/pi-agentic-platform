import type { Logger } from "../../kernel/logger.ts";
import type { TriggerChanged } from "./triggers.ts";

export interface TriggerChangeFeed {
  /** Hears every trigger saved, switched, rotated or deleted, after the stream and the scheduler were told; returns the way to stop. */
  onTriggerChanged(listener: (change: TriggerChanged) => void): () => void;
}

/**
 * The one `triggerChanged` callback of the module: `forward` (the stream and the scheduler) runs as it did, then each
 * listener hears the change. A listener that throws is logged and the next one still runs; so do the listeners when
 * `forward` throws (the caller logs that one).
 */
export function createTriggerChanges(
  logger: Logger,
  forward: (change: TriggerChanged) => void,
): { changed(change: TriggerChanged): void } & TriggerChangeFeed {
  const listeners = new Set<(change: TriggerChanged) => void>();
  return {
    changed(change) {
      try {
        forward(change);
      } finally {
        for (const listener of [...listeners]) {
          try {
            listener(change);
          } catch (error) {
            logger.warn("trigger_listener_failed", { err: error });
          }
        }
      }
    },
    onTriggerChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
