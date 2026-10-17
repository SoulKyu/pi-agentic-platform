import { CHILD_VIEWS, type ChildSummary, type ChildView, type Dialog } from "@pap/contracts";
import { sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { LiveSession } from "./live-session.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionsStore } from "./store.ts";

/** What the subagents module answers for a parent's screen: its newest children, newest first (M11R140). */
export interface ChildSource {
  childrenOf(ownerId: string, parentSessionId: string, limit: number): ChildSummary[];
}

/** The children's dialogs, in one event or one snapshot, together: the socket allows 1 MiB a frame (M11R140). */
export const CHILDREN_BYTES = 256 * 1024;

/** The session events after which a child's open dialogs, or its state, may have changed. */
const CHILD_EVENTS: ReadonlySet<string> = new Set(["status", "dialog_open", "dialog_closed"]);

/**
 * The children as one event carries them: each one's open dialogs, approvals first (the policy holds a tool call on them),
 * in their own order, while the whole stays within `budget` JSON bytes. A dialog left out is counted in `hiddenDialogs`, so
 * the screen can say that something waits that it cannot show.
 */
export function fitChildren(
  children: ReadonlyArray<ChildSummary & { readonly dialogs: readonly Dialog[] }>,
  budget = CHILDREN_BYTES,
): ChildView[] {
  let used = sizeOf(children.map((child) => ({ ...child, dialogs: [], hiddenDialogs: 0 })));
  return children.map(({ dialogs, ...summary }) => {
    const kept = new Set<Dialog>();
    const approvalsFirst = [
      ...dialogs.filter((dialog) => dialog.method === "approval"),
      ...dialogs.filter((dialog) => dialog.method !== "approval"),
    ];
    for (const dialog of approvalsFirst) {
      const size = sizeOf(dialog) + 1;
      if (kept.size >= 64 || used + size > budget) continue;
      used += size;
      kept.add(dialog);
    }
    const shown = dialogs.filter((dialog) => kept.has(dialog));
    return { ...summary, dialogs: shown, hiddenDialogs: dialogs.length - shown.length };
  });
}

export interface ChildrenDeps {
  readonly store: Pick<SessionsStore, "get">;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly hub: Pick<StreamHub, "publish">;
  readonly publisher: Pick<ShellPublisher, "changed">;
  readonly logger: Logger;
}

/**
 * M11R140: the parent's session stream carries its children and the dialogs they wait on. The owner answers on the parent's
 * screen with the child's own session id, so permissions and receipts are the child's, unchanged.
 */
export function createChildren(deps: ChildrenDeps) {
  const { store, live } = deps;
  let source: ChildSource | null = null;
  // The children with an open dialog, by child id; only a child's own events change it, so it holds at most the live workers.
  const waiting = new Map<string, string>();

  function viewsOf(parentSessionId: string): ChildView[] {
    const parent = store.get(parentSessionId);
    if (!source || !parent) return [];
    try {
      const summaries = source.childrenOf(parent.ownerId, parentSessionId, CHILD_VIEWS).slice(0, CHILD_VIEWS);
      return fitChildren(
        summaries.map((summary) => ({ ...summary, dialogs: live.get(summary.id)?.dialogs() ?? [] })),
      );
    } catch (error) {
      deps.logger.warn("children_view_failed", { sessionId: parentSessionId, err: error });
      return [];
    }
  }

  /** The parent's stream and its sidebar line are told the children changed. */
  function changed(parentSessionId: string): void {
    try {
      deps.hub.publish("session", parentSessionId, { kind: "subagents", children: viewsOf(parentSessionId) });
    } catch (error) {
      deps.logger.warn("children_publish_failed", { sessionId: parentSessionId, err: error });
    }
    deps.publisher.changed(parentSessionId);
  }

  return {
    setSource(next: ChildSource): void {
      source = next;
    },
    viewsOf,
    changed,
    /** Every event a session publishes: a child's dialogs and state reach its parent's stream. */
    published(sessionId: string, event: { readonly kind: string }): void {
      if (!CHILD_EVENTS.has(event.kind)) return;
      const parent = store.get(sessionId)?.parentSessionId;
      if (parent === undefined) return;
      if ((live.get(sessionId)?.dialogs().length ?? 0) > 0) waiting.set(sessionId, parent);
      else waiting.delete(sessionId);
      changed(parent);
    },
    /** A child of the session waits for an answer. */
    waiting(sessionId: string): boolean {
      for (const parent of waiting.values()) if (parent === sessionId) return true;
      return false;
    },
    /** A child of the owner's agent waits for an answer (the agent's rail shows `needs input`). */
    waitingAgent(ownerId: string, agentId: string): boolean {
      for (const childId of waiting.keys()) {
        const row = store.get(childId);
        if (row?.ownerId === ownerId && row.agentId === agentId) return true;
      }
      return false;
    },
  };
}
