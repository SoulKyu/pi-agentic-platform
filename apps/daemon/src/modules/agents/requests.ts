import { randomUUID } from "node:crypto";
import { type Caller, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cleanLabel, cutUnits } from "../../kernel/text.ts";
import type { AuditPort } from "../audit/index.ts";
import { PlatformRefusal } from "../platform/index.ts";
import { actorOf } from "./view.ts";

/** Pending requests one agent may have open, by kind (M11R101). */
export const OPEN_LIMITS = { approve: 4, secret: 3 } as const;
/** The columns' limits, in UTF-16 units. */
const TITLE_UNITS = 500;
const DETAIL_UNITS = 1000;

export type RequestKind = keyof typeof OPEN_LIMITS;
/** How a request ended; `approved` and `denied` are an approval's answers. */
export type RequestEnd = "approved" | "denied" | "answered" | "declined" | "expired" | "cancelled";

const ITEM_KIND = { approve: "agent_approve", secret: "secret_request" } as const;

/** What the requests service asks of the Inbox's agent-items port (M11R91). */
export interface RequestItems {
  upsertAgentItem(input: {
    readonly ownerId: string;
    readonly kind: string;
    readonly agentId: string | null;
    readonly title?: string;
    readonly refId: string;
    readonly detail?: string | null;
    readonly toHandle: boolean;
  }): boolean;
  resolveRef(
    ownerId: string,
    kind: string,
    refId: string,
    resolution: "answered" | "timed_out" | null,
  ): boolean;
}

export interface RequestsDeps {
  readonly db: Db;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Pick<Logger, "warn" | "error">;
  readonly items: RequestItems;
  readonly audit: Pick<AuditPort, "append">;
  /** The request opened or closed: the `agents` stream tells the owner's browsers (Task 17). */
  changed(ownerId: string, requestId: string): void;
  /** The database is one a newer pap wrote: nothing is answered or expired. */
  readonly readOnly: boolean;
}

/** Agent or model text as stored: hidden characters gone, one line, clipped on a code point; null when nothing is left. */
export function cleanText(raw: string | null | undefined, units: number): string | null {
  const line = cleanLabel(raw, units);
  if (line === null) return null;
  const text = cutUnits(line, units).trimEnd();
  return text === "" ? null : text;
}

interface Row {
  readonly id: string;
  readonly owner_id: string;
  readonly agent_id: string;
  readonly kind: RequestKind;
  readonly state: string;
}

/**
 * What an agent waits for from the owner (M11R101). The rows are `agent_requests`; each pending one has a to-handle Inbox
 * item (`ref_id` = the request id) and shows on the `agents` stream. Whoever closes a request (the owner's answer, the
 * op's 25 minutes, the op's cancel, a restart) goes through `close`, so the row, the item, the stream and the op's wait
 * always agree.
 */
export function createRequests(deps: RequestsDeps) {
  const { db, items, logger } = deps;
  /** The op waiting for each request: one per request, bounded by the open requests (4 + 3 per agent). */
  const waiters = new Map<string, (end: RequestEnd) => void>();

  const rowOf = (id: string): Row | null =>
    db.get<Row>("SELECT id, owner_id, agent_id, kind, state FROM agent_requests WHERE id = $id", { id }) ??
    null;

  function tell(ownerId: string, requestId: string): void {
    try {
      deps.changed(ownerId, requestId);
    } catch (error) {
      logger.warn("agent_request_publish_failed", { err: error });
    }
  }

  /**
   * Pending to `end`, once. The item is closed after the row, so a refused item write never reopens the request.
   * `refHash`: the SHA-256 of a one-use ref, kept by a secret request's answer (never the ref).
   */
  function close(
    id: string,
    end: RequestEnd,
    resolution: "answered" | "timed_out" | null,
    refHash: string | null = null,
  ): boolean {
    const row = rowOf(id);
    if (!row) {
      // The row went with its agent (deleted while the call waited): nobody else will wake the waiter.
      settle(id, end);
      return false;
    }
    const changed = db.run(
      "UPDATE agent_requests SET state = $end, answered_at = $now, ref_hash = $refHash WHERE id = $id AND state = 'pending'",
      { id, end, now: deps.clock.now(), refHash },
    );
    if (changed.changes !== 1) return false;
    try {
      items.resolveRef(row.owner_id, ITEM_KIND[row.kind], id, resolution);
    } catch (error) {
      logger.warn("agent_request_item_failed", { err: error });
    }
    tell(row.owner_id, id);
    settle(id, end);
    return true;
  }

  function settle(id: string, end: RequestEnd): void {
    const waiter = waiters.get(id);
    waiters.delete(id);
    waiter?.(end);
  }

  /** Closing needs a database this pap may write: on a newer one the call is refused, and logged. */
  function closeWritable(id: string, end: "expired" | "cancelled", resolution: "timed_out" | null): boolean {
    if (!deps.readOnly) return close(id, end, resolution);
    logger.warn("agent_request_close_skipped_read_only", { end });
    return false;
  }

  // Boot: a request still pending belongs to a call of a worker the restart ended; nobody could act on the answer.
  if (!deps.readOnly) {
    for (const row of db.all<Row>(
      "SELECT id, owner_id, agent_id, kind, state FROM agent_requests WHERE state = 'pending' ORDER BY created_at, id",
    ))
      close(row.id, "expired", "timed_out");
  }

  return {
    /** A pending request and its Inbox item; the id. `limit_reached` past the agent's open ones, `not_found` for an agent that is not the owner's. */
    open(input: {
      readonly kind: RequestKind;
      readonly ownerId: string;
      readonly agentId: string;
      readonly sessionId: string;
      readonly title: string;
      readonly detail: string | null;
      readonly expiresAt: number;
    }): string {
      const title = cleanText(input.title, TITLE_UNITS);
      if (title === null) throw new PlatformRefusal("bad_request");
      const detail = cleanText(input.detail, DETAIL_UNITS);
      const id = randomUUID();
      const refusal = db.transaction((): PlatformRefusal | null => {
        const open = db.get<{ n: number }>(
          "SELECT count(*) AS n FROM agent_requests WHERE agent_id = $agentId AND kind = $kind AND state = 'pending'",
          { agentId: input.agentId, kind: input.kind },
        );
        if ((open?.n ?? 0) >= OPEN_LIMITS[input.kind]) return new PlatformRefusal("limit_reached");
        const inserted = db.run(
          `INSERT INTO agent_requests (id, agent_id, owner_id, session_id, kind, title, detail, state, created_at, expires_at)
           SELECT $id, $agentId, $ownerId, $sessionId, $kind, $title, $detail, 'pending', $now, $expiresAt
           WHERE EXISTS (SELECT 1 FROM agents WHERE id = $agentId AND owner_id = $ownerId)`,
          {
            id,
            agentId: input.agentId,
            ownerId: input.ownerId,
            sessionId: input.sessionId.slice(0, 128),
            kind: input.kind,
            title,
            detail,
            now: deps.clock.now(),
            expiresAt: input.expiresAt,
          },
        );
        return inserted.changes === 1 ? null : new PlatformRefusal("not_found");
      });
      if (refusal) throw refusal;
      try {
        items.upsertAgentItem({
          ownerId: input.ownerId,
          kind: ITEM_KIND[input.kind],
          agentId: input.agentId,
          refId: id,
          detail: title,
          toHandle: true,
        });
      } catch (error) {
        logger.warn("agent_request_item_failed", { err: error });
      }
      tell(input.ownerId, id);
      return id;
    },

    /**
     * The owner's answer to an approval (M11R102). A token never answers (`forbidden`); a request that is closed, not an
     * approval or not the caller's is `not_found`. Approving tells the agent yes and runs nothing by itself.
     */
    answer(caller: Caller, requestId: string, approved: boolean): void {
      if (caller.kind !== "session") throw new PapError("forbidden");
      if (deps.readOnly) throw new PapError("read_only");
      const row = rowOf(requestId);
      if (!row || row.owner_id !== caller.userId || row.kind !== "approve" || row.state !== "pending")
        throw new PapError("not_found");
      // The row first: an answer nobody can trace is refused, and the request stays open.
      try {
        deps.audit.append({
          ownerId: caller.userId,
          ...actorOf(caller),
          kind: "policy",
          reason: "agent approval",
          detail: { agentId: row.agent_id, requestId, approved },
        });
      } catch (error) {
        logger.warn("agent_approval_audit_failed", { err: error });
        throw new PapError("internal");
      }
      if (!close(requestId, approved ? "approved" : "denied", "answered")) throw new PapError("not_found");
    },

    /**
     * The pending `secret` request of this owner, as the secrets service answers it (M11R103); null when there is none:
     * unknown, closed, an approval, or another owner's. `name` is the title the op stored.
     */
    secretOf(ownerId: string, requestId: string) {
      const row = db.get<{ id: string; agent_id: string; session_id: string; title: string }>(
        `SELECT id, agent_id, session_id, title FROM agent_requests
         WHERE id = $id AND owner_id = $ownerId AND kind = 'secret' AND state = 'pending'`,
        { id: requestId, ownerId },
      );
      return row ? { id: row.id, agentId: row.agent_id, sessionId: row.session_id, name: row.title } : null;
    },

    /**
     * Closes a secret request the secrets service has already acted on (and audited): `answered` with the hash of the ref
     * it gave the agent, or `declined` with none. False when it was already closed or is not a secret request.
     */
    closeSecret(id: string, end: "answered" | "declined", refHash: string | null): boolean {
      if (deps.readOnly || rowOf(id)?.kind !== "secret") return false;
      return close(id, end, "answered", refHash);
    },

    /** Every pending request of the agent is closed as cancelled (quarantine, M11R115); how many. */
    cancelAllOf(ownerId: string, agentId: string): number {
      if (deps.readOnly) return 0;
      let closed = 0;
      for (const row of db.all<{ id: string }>(
        "SELECT id FROM agent_requests WHERE owner_id = $ownerId AND agent_id = $agentId AND state = 'pending' ORDER BY created_at, id",
        { ownerId, agentId },
      ))
        if (close(row.id, "cancelled", null)) closed += 1;
      return closed;
    },

    /** The request's time is up; false when it was already closed. */
    expire: (id: string): boolean => closeWritable(id, "expired", "timed_out"),
    /** The call that asked ended (Stop, a dead worker); false when it was already closed. */
    cancel: (id: string): boolean => closeWritable(id, "cancelled", null),

    /** Settles with how the request ended; at once for one that is already closed or unknown (`cancelled`). One waiter per request. */
    wait(id: string): Promise<RequestEnd> {
      const row = rowOf(id);
      if (!row) return Promise.resolve("cancelled");
      if (row.state !== "pending") return Promise.resolve(row.state as RequestEnd);
      return new Promise((resolve) => {
        waiters.set(id, resolve);
      });
    },
  };
}
export type Requests = ReturnType<typeof createRequests>;
