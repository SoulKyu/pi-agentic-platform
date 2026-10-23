import type { HealthKind, HealthSource } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";

/** Daemon-internal: `ownerId` routes the event and never leaves the daemon. */
export interface HealthEventInput {
  readonly ownerId: string;
  readonly kind: HealthKind;
  readonly code: string;
  readonly sourceRef: HealthSource;
}

export interface HealthEvents {
  on(listener: (input: HealthEventInput) => void): () => void;
  emit(input: HealthEventInput): void;
}

/** A listener that throws is logged and skipped: one subscriber never stops the others nor the move that caused the event. */
export function createHealthEvents(logger: Logger): HealthEvents {
  const listeners = new Set<(input: HealthEventInput) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(input) {
      for (const listener of [...listeners]) {
        try {
          listener(input);
        } catch (error) {
          logger.warn("health_listener_failed", { kind: input.kind, err: error });
        }
      }
    },
  };
}
