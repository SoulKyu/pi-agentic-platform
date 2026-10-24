import { randomUUID } from "node:crypto";
import type { InboxItem } from "@pap/contracts";
import type { InboxChange } from "./service.ts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cleanLabel, cutUnits } from "../../kernel/text.ts";
import type { createInboxStore } from "./store.ts";

/** The longest `detail` kept (the column's limit, in UTF-16 units). */
const DETAIL_UNITS = 500;
/** The column limits of the agent fields (migration `agent_items`), checked before SQL so an event path never throws from a CHECK. */
const REF_ID_MAX = 128;
const ENTRY_ID_MAX = 128;
const AGENT_ID_MIN = 6;
const AGENT_ID_MAX = 48;
/** The most refs `openRefs` returns: far past any queue a module keeps. */
const OPEN_REFS_MAX = 1000;

/** What an agent wrote, as kept: one line, hidden characters gone (the emoji joiner stays), clipped on a code point; null when nothing is left. */
export const cleanDetail = (raw: string | null | undefined): string | null => {
  const line = cleanLabel(raw, DETAIL_UNITS);
  if (line === null) return null;
  const text = cutUnits(line, DETAIL_UNITS).trimEnd();
  return text === "" ? null : text;
};

const between = (value: string, min: number, max: number): boolean =>
  value.length >= min && value.length <= max;

export interface AgentItemInput {
  readonly ownerId: string;
  readonly kind: string;
  /** Null for an item about a project box. */
  readonly agentId: string | null;
  /** The subject line (a project's name); none: the agent label. */
  readonly title?: string;
  /** The request, staged fact or agent the item is about: one item per `(refId, kind)`. */
  readonly refId: string;
  readonly entryId?: string | null;
  readonly detail?: string | null;
  readonly toHandle: boolean;
}

export interface AgentItemsDeps {
  readonly store: Pick<
    ReturnType<typeof createInboxStore>,
    "byRef" | "upsertRef" | "resolveRef" | "removeRef" | "removeAgentItems" | "openRefs"
  >;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Room for one more info item (the oldest read info item goes at the cap); false when none can. */
  roomFor(ownerId: string): boolean;
  announce(ownerId: string, items: readonly InboxItem[]): void;
  /** Tells the listeners (M12R22); called after `announce`, for the writes and closings only. */
  changed(ownerId: string, item: InboxItem, change: InboxChange): void;
  counts(ownerId: string): void;
}

/**
 * The Inbox's port for agent items (M11R91). Every call names the owner: another owner's row with the same ref and kind
 * is never read, reopened, resolved nor removed. Callers answer nothing here; they write and resolve items.
 */
export function createAgentItems(deps: AgentItemsDeps) {
  const { store, clock, logger } = deps;
  return {
    /**
     * A to-handle item is always written (M10R49); an info item past the cap evicts or is skipped. False when the write
     * was refused (an over-long id, or another owner's row of this ref and kind) or skipped; the refusals are logged.
     */
    upsertAgentItem(input: AgentItemInput): boolean {
      if (
        !between(input.refId, 1, REF_ID_MAX) ||
        !between(input.entryId ?? "", 0, ENTRY_ID_MAX) ||
        (input.agentId !== null && !between(input.agentId, AGENT_ID_MIN, AGENT_ID_MAX))
      ) {
        logger.warn("inbox_agent_item_refused", { kind: input.kind, reason: "length" });
        return false;
      }
      const existing = store.byRef(input.kind, input.refId);
      if (existing && existing.ownerId !== input.ownerId) {
        logger.warn("inbox_agent_item_refused", { kind: input.kind, reason: "owner" });
        return false;
      }
      if (!existing && !input.toHandle && !deps.roomFor(input.ownerId)) return false;
      const item = store.upsertRef({
        id: randomUUID(),
        ownerId: input.ownerId,
        kind: input.kind,
        toHandle: input.toHandle,
        agentId: input.agentId,
        ...(input.title === undefined ? {} : { title: input.title }),
        refId: input.refId,
        entryId: input.entryId ?? null,
        detail: cleanDetail(input.detail),
        at: clock.now(),
      });
      if (!item) return false;
      deps.announce(input.ownerId, [item]);
      // Written again while still open is a refresh, not a next ask.
      if (!existing) deps.changed(input.ownerId, item, "created");
      else if (existing.item.resolvedAt !== null) deps.changed(input.ownerId, item, "reopened");
      return true;
    },

    /** Closes the owner's open item of this ref and kind; true when one was open. */
    resolveRef(
      ownerId: string,
      kind: string,
      refId: string,
      resolution: "answered" | "timed_out" | null,
    ): boolean {
      const item = store.resolveRef(ownerId, kind, refId, resolution, clock.now());
      if (item) {
        deps.announce(ownerId, [item]);
        deps.changed(ownerId, item, "resolved");
      }
      return item !== null;
    },

    /**
     * The open to-handle items of this kind with their owner, agent and ref. Not owner-scoped: it returns every owner's
     * refs, for a module that restarted to find what it already raised.
     */
    openRefs(kind: string): Array<{ ownerId: string; agentId: string; refId: string }> {
      return store.openRefs(kind, OPEN_REFS_MAX);
    },

    /** Deletes every item of the owner that carries this agent (the agent was deleted); the badges are told. */
    removeAgentItems(ownerId: string, agentId: string): void {
      if (store.removeAgentItems(ownerId, agentId) > 0) deps.counts(ownerId);
    },

    /** Deletes the owner's item of this ref and kind (its subject is gone). */
    removeRef(ownerId: string, kind: string, refId: string): void {
      if (store.removeRef(ownerId, kind, refId)) deps.counts(ownerId);
    },
  };
}
