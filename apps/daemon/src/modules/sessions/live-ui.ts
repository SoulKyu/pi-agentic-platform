import {
  type ApprovalAnswer,
  type ApprovalInvalidRecord,
  type ApprovalRequestRecord,
  type Dialog,
  type DialogResponse,
  PapError,
  type Panel,
  type SessionStreamEvent,
  type StatusEntry,
  UI_LIMITS,
  type UiRequestRecord,
  type Widget,
  type WorkerRecord,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RateLimiter } from "../../kernel/rate-limit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { createDecorations } from "./decorations.ts";
import { type CancelReason, createDialogRegistry, type Grant } from "./dialogs.ts";
import { createKeyedThrottle } from "./keyed-throttle.ts";
import { createNoticeLimiter } from "./notices.ts";
import { createPanels } from "./panels.ts";
import { clip, SAFE_EVENT_NAME } from "./worker-text.ts";

const CANCEL_NOTICES: Partial<Record<CancelReason, string>> = {
  too_large: "An extension asked a question that was too large to show. It was cancelled.",
  limit: "An extension asked a question while too many were waiting. It was cancelled.",
};

const APPROVAL_CANCEL_NOTICE = "A question about a tool call could not be shown. The call was blocked.";

export interface LiveUiDeps {
  readonly handle: WorkerHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly limiter: RateLimiter;
  publish(event: SessionStreamEvent): void;
}

export interface LiveUi {
  onUiRequest(record: UiRequestRecord): void;
  onUiClosed(id: string): void;
  onExtensionError(record: Extract<WorkerRecord, { type: "extension_error" }>): void;
  /** The policy's own question (an approval card). */
  onApprovalRequest(record: ApprovalRequestRecord): void;
  /** An approval the record schema refused: the policy is told it was closed (fail closed), the person is told once in a while. */
  onApprovalInvalid(record: ApprovalInvalidRecord): void;
  /**
   * Answers a dialog. For an approval it returns the answer sent and the grant it would give. Nothing is taken until
   * the answer is known to be one the dialog offers.
   */
  answer(dialogId: string, response: DialogResponse): { answer: ApprovalAnswer; grant: Grant } | null;
  dialogs(): Dialog[];
  /** Forgets every dialog, for a worker that is gone; returns the ones that were open. */
  clear(): Dialog[];
  onPanelRender(id: string, lines: readonly string[]): void;
  onPanelClose(id: string): void;
  /** Keystrokes for an open panel. `not_found` for an id that is not open, `bad_request` for data outside 1..4096. */
  panelInput(id: string, data: string): void;
  /** Asks the worker to cancel every open panel (the panels close when it says so, or when the worker is gone). */
  cancelPanels(): void;
  statuses(): StatusEntry[];
  widgets(): Widget[];
  title(): string | null;
  panels(): Panel[];
  /** Forgets statuses, widgets, the title and panels, cancels what waits in the throttle and the notice window; returns the open panel ids. */
  clearDecorations(): string[];
}

/**
 * What the person's response means for an approval card: an answer the card offers (`confirmed` is once or deny, and
 * must be offered too), a dismissed card is a deny. Anything else is `bad_request`, before anything is taken.
 */
function approvalAnswerOf(dialog: Dialog, response: DialogResponse): ApprovalAnswer {
  const offered = (answer: ApprovalAnswer): ApprovalAnswer => {
    if (!dialog.answers?.includes(answer)) throw new PapError("bad_request");
    return answer;
  };
  if ("answer" in response) return offered(response.answer);
  if ("confirmed" in response) return offered(response.confirmed ? "once" : "deny");
  if ("cancelled" in response) return "deny";
  throw new PapError("bad_request");
}

export function createLiveUi(deps: LiveUiDeps): LiveUi {
  const { handle, logger, limiter } = deps;
  const dialogs = createDialogRegistry();
  const decorations = createDecorations();
  const throttle = createKeyedThrottle({ clock: deps.clock, publish: deps.publish });
  const extensionNotices = createNoticeLimiter({ clock: deps.clock, publish: deps.publish });
  const panels = createPanels({
    clock: deps.clock,
    publish: deps.publish,
    cancel: (id) => void handle.send({ type: "custom_cancel", id }),
    say: (notice) => deps.publish({ kind: "notice", ...notice }),
    throttle,
    stale: () => {
      const said = limiter.check("panel_record_ignored");
      if (said.allowed) logger.warn("panel_record_ignored", { suppressed: said.suppressed });
    },
  });

  // Every dialog is answered; only the telling is spaced out, so an extension that asks in a loop cannot flood the
  // user's screen or the log. Approvals have a key of their own: an extension's noise cannot hide their notice.
  function said(key: string, reason: CancelReason, method: string, notice: string | undefined): void {
    const verdict = limiter.check(key);
    if (!verdict.allowed) return;
    logger.warn("dialog_cancelled", {
      reason,
      method: clip(method).slice(0, 64),
      suppressed: verdict.suppressed,
    });
    if (notice) deps.publish({ kind: "notice", level: "warning", text: notice });
  }
  // The policy hears a closed question, never a refusal: the model must not be told a person said no (M2R62).
  function refuseApproval(id: string, reason: CancelReason): void {
    handle.send({ type: "approval_response", id, answer: "deny", cancelled: true });
    said(`approval_${reason}`, reason, "approval", APPROVAL_CANCEL_NOTICE);
  }

  /** Closes the approval card open under `id`, if any, and answers it closed. Returns whether there was one. */
  function withdrawOpenApproval(id: string, reason: CancelReason): boolean {
    if (dialogs.peek(id)?.method !== "approval") return false;
    dialogs.take(id);
    deps.publish({ kind: "dialog_closed", id });
    refuseApproval(id, reason);
    return true;
  }

  // Status, widget and title events share the throttle; a notice goes through the extension limit; editor text at once.
  function decorate(record: UiRequestRecord): void {
    const event = decorations.apply(record);
    if (!event) {
      const said = limiter.check("decoration_refused");
      if (said.allowed) {
        logger.warn("decoration_refused", {
          method: clip(record.method).slice(0, 64),
          suppressed: said.suppressed,
        });
      }
      return;
    }
    switch (event.kind) {
      case "status_bar":
        throttle.push(`status:${event.key}`, event);
        return;
      case "widget":
        throttle.push(`widget:${event.key}`, event);
        return;
      case "title":
        throttle.push("title", event);
        return;
      case "notice":
        extensionNotices.add({ level: event.level, text: event.text, source: "extension" });
        return;
      default:
        deps.publish(event);
    }
  }

  return {
    onUiRequest(record) {
      const verdict = dialogs.offer(record);
      if (verdict.kind === "opened") {
        deps.publish({ kind: "dialog_open", dialog: verdict.dialog });
      } else if (verdict.kind === "cancel") {
        handle.send({ type: "extension_ui_response", id: record.id, cancelled: true });
        said(`dialog_${verdict.reason}`, verdict.reason, record.method, CANCEL_NOTICES[verdict.reason]);
      } else {
        decorate(record);
      }
    },
    onApprovalRequest(record) {
      // A second question under the id of an open approval never swaps the text of the card the person is reading:
      // the open one is withdrawn and answered closed, then the new one opens.
      withdrawOpenApproval(record.id, "collision");
      const verdict = dialogs.offerApproval(record);
      if (verdict.kind === "opened") deps.publish({ kind: "dialog_open", dialog: verdict.dialog });
      else if (verdict.kind === "cancel") refuseApproval(record.id, verdict.reason);
    },
    onApprovalInvalid(record) {
      // The id is the policy's waiter too: a card left open under it could be answered a second time, after the
      // waiter was told the question was closed. An extension's dialog of that id is not the policy's and stays.
      if (!withdrawOpenApproval(record.id, record.reason)) refuseApproval(record.id, record.reason);
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
      // pap's own sentence about an extension, not text the extension wrote: no `source` (only an extension's own text has one).
      extensionNotices.add({ level: "error", text: `An extension failed${during}.` });
    },
    answer(dialogId, response) {
      const open = dialogs.peek(dialogId); // looks without taking
      if (!open) throw new PapError("not_found");
      if (open.method !== "approval") {
        if ("answer" in response) throw new PapError("bad_request");
        dialogs.take(dialogId);
        const delivered = handle.send({ type: "extension_ui_response", id: dialogId, ...response });
        deps.publish({ kind: "dialog_closed", id: dialogId });
        if (!delivered) throw new PapError("worker_failed");
        return null;
      }
      const answer = approvalAnswerOf(open, response); // throws before anything is taken
      const entry = dialogs.takeEntry(dialogId);
      const delivered = handle.send({ type: "approval_response", id: dialogId, answer });
      deps.publish({ kind: "dialog_closed", id: dialogId });
      if (!delivered) throw new PapError("worker_failed");
      return entry?.grant ? { answer, grant: entry.grant } : null;
    },
    dialogs: () => dialogs.list(),
    clear: () => dialogs.clear(),
    onPanelRender: (id, lines) => panels.render(id, lines),
    onPanelClose: (id) => panels.close(id),
    panelInput(id, data) {
      if (data.length === 0 || data.length > UI_LIMITS.panelInput) throw new PapError("bad_request");
      if (!panels.has(id)) throw new PapError("not_found");
      if (!handle.send({ type: "custom_input", id, data })) throw new PapError("not_found");
    },
    cancelPanels() {
      for (const panel of panels.list()) handle.send({ type: "custom_cancel", id: panel.id });
    },
    statuses: () => decorations.statuses(),
    widgets: () => decorations.widgets(),
    title: () => decorations.title(),
    panels: () => panels.list(),
    clearDecorations() {
      throttle.clear();
      extensionNotices.stop();
      decorations.clear();
      return panels.clear();
    },
  };
}
