import type { TaskState, TaskView } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";

/**
 * What the runner tells the rest of the automation module (Tasks 5b, 6, 11 listen). A terminal `task` event carries the
 * state the task left, so the end hook knows which move it is hearing. `ownerId` routes the stream event.
 */
export type AutomationEvent =
  | {
      readonly kind: "task";
      readonly ownerId: string;
      readonly task: TaskView;
      readonly previous: TaskState | null;
    }
  | {
      readonly kind: "attention";
      readonly taskId: string;
      readonly sessionId: string;
      readonly needsInput: boolean;
    }
  | { readonly kind: "attention_timeout"; readonly taskId: string; readonly denied: number };

export interface AutomationEvents {
  on(listener: (event: AutomationEvent) => void): () => void;
  emit(event: AutomationEvent): void;
}

/** A listener that throws is logged and skipped: one subscriber never stops the others nor the move that caused the event. */
export function createAutomationEvents(logger: Logger): AutomationEvents {
  const listeners = new Set<(event: AutomationEvent) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          logger.warn("automation_listener_failed", { kind: event.kind, err: error });
        }
      }
    },
  };
}
