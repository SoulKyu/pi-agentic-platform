import type { PushClass } from "@pap/contracts";
import type { Logger } from "../../../kernel/logger.ts";
import type { Inbox, InboxItemEvent } from "../../inbox/index.ts";
import type { PushNotifier, PushRef } from "../service.ts";
import type { DigestVerdict } from "./digest.ts";
import type { EventRow } from "./events.ts";

/** M12R22: one line for every Inbox kind. A kind that is not here (a newer daemon wrote it) pushes nothing. */
const CLASS_OF: Readonly<Record<string, PushClass>> = {
  task_needs_input: "approval",
  agent_approve: "approval",
  secret_request: "approval",
  task_failed: "failed",
  task_interrupted: "failed",
  agent_notify: "notify",
  task_done: "done",
  task_limited: "done",
  agent_reply: "reply",
  delegation_done: "reply",
  memory_review: "review",
};

/**
 * What the push is about. A task's question is the session's question: it shares `push:approval:session:<id>` with the
 * attention feed (task 11), so one waiting session is one push (M12R2). Without a session there is nothing to open: Inbox only.
 */
function refOf(item: InboxItemEvent["item"]): PushRef | null {
  if (item.kind !== "task_needs_input") return { refKind: "inbox", refId: item.id };
  return item.sessionId === null ? null : { refKind: "session", refId: item.sessionId };
}

export interface InboxSourceDeps {
  readonly inbox: Pick<Inbox, "onItem" | "get" | "registeredName">;
  readonly notifier: Pick<PushNotifier, "notify" | "cancel" | "keyOf">;
  readonly logger: Pick<Logger, "warn">;
  /** The registry name of an agent (the agents port); none: agent items are generic. */
  readonly agentName?: (ownerId: string, agentId: string) => string | null;
}

/**
 * The Inbox as a push source (task 10). It listens to `Inbox.onItem`, which reports the rows written, reopened and
 * closed, never a read mark. It also gives the two lines of the Inbox's refs (`refKind: "inbox"`) for the compose tables:
 * `waiting` (the send handler) and `verdict` (the digest). Errors of `notify` and `cancel` propagate to the Inbox, which logs them.
 */
export function wireInboxSource(deps: InboxSourceDeps) {
  const { inbox, notifier } = deps;

  /** The registry name only, never the item's own text (`triggerName` can be a task title, `detail` is the agent's). */
  function nameOf({ ownerId, item }: InboxItemEvent): string | null {
    if (item.taskId !== null) return inbox.registeredName(item.taskId);
    if (item.agentId === null || !deps.agentName) return null;
    try {
      return deps.agentName(ownerId, item.agentId);
    } catch (error) {
      deps.logger.warn("push_name_lookup_failed", { err: error });
      return null;
    }
  }

  const stop = inbox.onItem((event) => {
    const { ownerId, item, change } = event;
    const cls = CLASS_OF[item.kind];
    const ref = cls === undefined ? null : refOf(item);
    if (cls === undefined || ref === null) return;
    if (change === "resolved") {
      // Only a question has a push to withdraw. Answered is an answer; timed out is the request denied in its sleep
      // (decision 90 a3); anything else (the task ended, the request was withdrawn) is the neutral `gone`.
      if (cls === "approval") {
        const reason =
          item.resolution === "answered" ? "answered" : item.resolution === "timed_out" ? "expired" : "gone";
        notifier.cancel(notifier.keyOf(cls, ref.refKind, ref.refId), reason);
      }
      return;
    }
    const name = nameOf(event);
    notifier.notify({ ownerId, cls, ...ref, ...(name === null ? {} : { name }) });
  });

  return {
    stop,
    /** `stillWaiting` for an event whose ref is an Inbox item: a question while its item is open, news while it exists. */
    waiting(event: EventRow): boolean {
      const item = inbox.get(event.ownerId, event.refId);
      return item !== null && (event.cls !== "approval" || item.resolvedAt === null);
    },
    /** The digest's judgement of a held event whose ref is an Inbox item (M12R17): a timed-out question is `expired`. */
    verdict(event: EventRow): DigestVerdict {
      const item = inbox.get(event.ownerId, event.refId);
      if (item === null) return "gone";
      if (event.cls !== "approval" || item.resolvedAt === null) return "waiting";
      return item.resolution === "timed_out" ? "expired" : "gone";
    },
  };
}
