import {
  type Dialog,
  type DialogResponse,
  PapError,
  type PiEvent,
  type SessionStreamEvent,
  type UiRequestRecord,
  type WorkerRecord,
} from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { RateLimiter } from "../../kernel/rate-limit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { type CancelReason, createDialogRegistry } from "./dialogs.ts";
import { clip, SAFE_EVENT_NAME } from "./worker-text.ts";

const CANCEL_NOTICES: Partial<Record<CancelReason, string>> = {
  too_large: "An extension asked a question that was too large to show. It was cancelled.",
  limit: "An extension asked a question while too many were waiting. It was cancelled.",
};

export interface LiveUiDeps {
  readonly handle: WorkerHandle;
  readonly logger: Logger;
  readonly limiter: RateLimiter;
  publish(event: SessionStreamEvent): void;
  publishPi(event: PiEvent): void;
}

export interface LiveUi {
  onUiRequest(record: UiRequestRecord): void;
  onUiClosed(id: string): void;
  onExtensionError(record: Extract<WorkerRecord, { type: "extension_error" }>): void;
  answer(dialogId: string, response: DialogResponse): void;
  dialogs(): Dialog[];
  /** Forgets every dialog, for a worker that is gone; returns the ones that were open. */
  clear(): Dialog[];
}

export function createLiveUi(deps: LiveUiDeps): LiveUi {
  const { handle, logger, limiter } = deps;
  const dialogs = createDialogRegistry();

  return {
    onUiRequest(record) {
      const verdict = dialogs.offer(record);
      if (verdict.kind === "opened") {
        deps.publish({ kind: "dialog_open", dialog: verdict.dialog });
      } else if (verdict.kind === "cancel") {
        // Every dialog is answered; only the telling is spaced out, so an extension that asks in a loop cannot flood
        // the user's screen or the log.
        handle.send({ type: "extension_ui_response", id: record.id, cancelled: true });
        const said = limiter.check(`dialog_${verdict.reason}`);
        if (!said.allowed) return;
        logger.warn("dialog_cancelled", {
          reason: verdict.reason,
          method: clip(record.method).slice(0, 64),
          suppressed: said.suppressed,
        });
        const notice = CANCEL_NOTICES[verdict.reason];
        if (notice) deps.publish({ kind: "notice", level: "warning", text: notice });
      } else {
        deps.publishPi(record);
      }
    },
    onUiClosed(id) {
      if (dialogs.take(id)) deps.publish({ kind: "dialog_closed", id });
    },
    // The worker's own words are logged, clipped, and never sent on: a client gets a fixed text (R66).
    onExtensionError(record) {
      logger.warn("extension_error", {
        extensionPath: clip(record.extensionPath),
        event: clip(record.event),
        error: clip(record.error),
      });
      const during = SAFE_EVENT_NAME.test(record.event) ? ` during ${record.event}` : "";
      deps.publish({ kind: "notice", level: "error", text: `An extension failed${during}.` });
    },
    answer(dialogId, response) {
      if (!dialogs.take(dialogId)) throw new PapError("not_found");
      const delivered = handle.send({ type: "extension_ui_response", id: dialogId, ...response });
      deps.publish({ kind: "dialog_closed", id: dialogId });
      if (!delivered) throw new PapError("worker_failed");
    },
    dialogs: () => dialogs.list(),
    clear: () => dialogs.clear(),
  };
}
