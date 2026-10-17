import type { Logger } from "../../../kernel/logger.ts";
import type { SessionsModule } from "../../sessions/index.ts";
import type { PushNotifier } from "../service.ts";
import type { DigestVerdict } from "./digest.ts";
import type { EventRow } from "./events.ts";

export interface SessionSourceDeps {
  /** The attention feed and the three lookups the source needs; nothing of a session's content. */
  readonly sessions: Pick<SessionsModule, "ownerOf"> & {
    readonly kindOf: (
      sessionId: string,
    ) => { readonly agentId: string | null; readonly parentSessionId: string | null } | null;
    readonly automation: Pick<SessionsModule["automation"], "onAttention" | "state">;
  };
  readonly notifier: Pick<PushNotifier, "notify" | "cancel" | "keyOf">;
  readonly logger: Pick<Logger, "warn">;
  /** The registry name of an agent (the agents port); none: every push is generic. */
  readonly agentName?: ((ownerId: string, agentId: string) => string | null) | undefined;
}

/**
 * Interactive approvals as a push source (M12R23). The shell publisher's flush tells `onAttention(sessionId, needsInput)`
 * when a session starts or stops needing an answer; the flush is already parent-aware, so a child's open dialog reports the
 * PARENT and the push opens the parent's card (M12R24). The source keeps the set of sessions the feed reported as waiting:
 * after a restart it is empty, and every pending approval push cancels, as M12R17 says (the workers and their dialogs died).
 * It reads no content: the question, the command and the tool arguments never reach the notifier.
 */
export function wireSessionSource(deps: SessionSourceDeps) {
  const { sessions, notifier } = deps;
  const waiting = new Set<string>();

  /** The registry name of the agent the session belongs to, never anything the session says. */
  function nameOf(ownerId: string, agentId: string | null): string | null {
    if (agentId === null || !deps.agentName) return null;
    try {
      return deps.agentName(ownerId, agentId);
    } catch (error) {
      deps.logger.warn("push_name_lookup_failed", { err: error });
      return null;
    }
  }

  const stopListening = sessions.automation.onAttention((sessionId, needsInput) => {
    if (!needsInput) {
      waiting.delete(sessionId);
      notifier.cancel(notifier.keyOf("approval", "session", sessionId), "answered");
      return;
    }
    const ownerId = sessions.ownerOf(sessionId);
    if (ownerId === null) return;
    // A child's own dialog is reported on the child too, but its card is answered from the PARENT's (whose report carries
    // it): one question, one push, opened on the parent (M12R24, verified by the int test).
    const kind = sessions.kindOf(sessionId);
    if (kind?.parentSessionId != null) return;
    waiting.add(sessionId);
    const name = nameOf(ownerId, kind?.agentId ?? null);
    notifier.notify({
      ownerId,
      cls: "approval",
      refKind: "session",
      refId: sessionId,
      ...(name === null ? {} : { name }),
    });
  });

  /** A waiting session whose row is still there and not archived: a worker that died has no dialog left to answer. */
  function stillWaiting(event: Pick<EventRow, "ownerId" | "refId">): boolean {
    if (!waiting.has(event.refId)) return false;
    const state = sessions.automation.state(event.ownerId, event.refId);
    if (state === null) {
      waiting.delete(event.refId);
      return false;
    }
    return !state.archived;
  }

  return {
    stop(): void {
      stopListening();
      waiting.clear();
    },
    /** `stillWaiting` for an event whose ref is a session: a question while it waits; news about a session is not a question. */
    waiting: (event: EventRow): boolean => event.cls !== "approval" || stillWaiting(event),
    /** The digest's judgement of a held session approval (M12R17): it waits or it is gone; a session question never times out. */
    verdict: (event: EventRow): DigestVerdict =>
      event.cls !== "approval" || stillWaiting(event) ? "waiting" : "gone",
  };
}
