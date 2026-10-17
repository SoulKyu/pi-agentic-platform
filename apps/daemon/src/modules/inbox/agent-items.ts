import { randomUUID } from "node:crypto";
import type { InboxItem } from "@pap/contracts";
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
/** The most refs `openRefs` returns: far past any queue a module keeps (the memory review's is 200). */
const OPEN_REFS_MAX = 1000;

/** What an agent or a memory fact wrote, as kept: one line, hidden characters gone (the emoji joiner stays), clipped on a code point; null when nothing is left. */
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
  readonly agentId: string;
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
        !between(input.agentId, AGENT_ID_MIN, AGENT_ID_MAX)
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
        refId: input.refId,
        entryId: input.entryId ?? null,
        detail: cleanDetail(input.detail),
        at: clock.now(),
      });
      if (!item) return false;
      deps.announce(input.ownerId, [item]);
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
      if (item) deps.announce(ownerId, [item]);
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
