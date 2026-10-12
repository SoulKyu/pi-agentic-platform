import {
  AuditView as AuditViewSchema,
  type AuditView,
  type Caller,
  type PolicyAuditEntry,
  PolicyAuditEntry as PolicyAuditEntrySchema,
  type ParamsOf,
  type ResultOf,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRowBudget } from "./budget.ts";
import { fitStages, fitToolNames, replaceNul, scrubKnownSecrets } from "./scrub.ts";
import type { AuditInsert, AuditRow, AuditStore } from "./store.ts";

/** One security-relevant event of the daemon itself (M5R45). Never a secret, a result or a failed sign-in. */
export interface AuditLine {
  readonly ownerId: string | null;
  readonly actor: "user" | "token" | "cli" | "system";
  readonly actorId?: string;
  readonly kind: "auth" | "policy" | "audit";
  readonly reason: string;
  readonly sessionId?: string;
  readonly detail?: Record<string, string | number | boolean | null>;
}

export interface AuditPort {
  /** Never throws: a failure logs `audit_append_failed` and the event goes on (M5R47). */
  append(line: AuditLine): void;
  /** Parses, scrubs and stores a worker's entry (it arrives as `unknown`). Null when it was malformed. */
  fromWorker(
    session: { readonly id: string; readonly ownerId: string },
    raw: unknown,
    context: { readonly containment: "scope" | "none" },
  ): PolicyAuditEntry | null;
}

export interface AuditService extends AuditPort {
  list(caller: Caller, params: ParamsOf<"audit.list">): ResultOf<"audit.list">;
}

const MAX_INVALID_PER_SESSION = 100;
const MAX_TRACKED_SESSIONS = 1_024;
const LOG_EVERY_MS = 60_000;
const REASON_MAX = 1_024;
const ARGS_MAX = 8_192;
const DEFAULT_LIMIT = 100;
const WORKER_ROWS_PER_MINUTE = 600;

interface InvalidCount {
  stored: number;
  dropped: number;
  loggedAt: number;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

function scrubbed(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : clip(scrubKnownSecrets(text).text, max);
}

// Field by field: the owner stays in the database, and a column added later reaches the wire only when named here.
const viewOf = (row: AuditRow): AuditView => ({
  id: row.id,
  at: row.at,
  actor: row.actor,
  actorId: row.actorId,
  kind: row.kind,
  sessionId: row.sessionId,
  toolCallId: row.toolCallId,
  parentToolCallId: row.parentToolCallId,
  tool: row.tool,
  category: row.category,
  decision: row.decision,
  reason: row.reason,
  stages: row.stages,
  args: row.args,
  detail: row.detail,
});

const nullable = (text: string | null, max: number): string | null =>
  text === null ? null : text.slice(0, max);

// A row the contract refuses is shown with what is wrong with it cut away: one bad row never fails a page.
const repaired = (view: AuditView): AuditView => ({
  ...view,
  actorId: nullable(view.actorId, 128),
  sessionId: view.sessionId ? view.sessionId.slice(0, 128) : null,
  toolCallId: nullable(view.toolCallId, 256),
  parentToolCallId: nullable(view.parentToolCallId, 256),
  tool: nullable(view.tool, 256),
  category: nullable(view.category, 32),
  reason: nullable(view.reason, REASON_MAX),
  args: nullable(view.args, ARGS_MAX),
  stages: [],
  detail: null,
});

export function createAuditService(deps: {
  readonly store: AuditStore;
  readonly clock: Clock;
  readonly logger: Logger;
}): AuditService {
  const { store, clock, logger } = deps;
  // Session id -> invalid records so far. Bounded: the oldest session is forgotten past 1 024 (M5R46).
  const invalid = new Map<string, InvalidCount>();
  let failureLoggedAt = Number.NEGATIVE_INFINITY;
  let failuresSuppressed = 0;
  let degradedLoggedAt = Number.NEGATIVE_INFINITY;

  /** True when the row was stored. A failure logs its kind (rate-limited, with how many it did not log). */
  function tryAppend(row: AuditInsert): boolean {
    try {
      store.append(row);
      return true;
    } catch {
      const now = clock.now();
      if (now - failureLoggedAt < LOG_EVERY_MS) failuresSuppressed++;
      else {
        failureLoggedAt = now;
        logger.error("audit_append_failed", { kind: row.kind, suppressed: failuresSuppressed });
        failuresSuppressed = 0;
      }
      return false;
    }
  }

  const budget = createRowBudget({
    clock,
    perMinute: WORKER_ROWS_PER_MINUTE,
    maxSessions: MAX_TRACKED_SESSIONS,
    onFirstDrop: (session) => logger.warn("audit_rows_dropped", { sessionId: session.id }),
    onMarker: (session, dropped) =>
      void tryAppend({
        at: clock.now(),
        ownerId: session.ownerId,
        actor: "worker",
        kind: "audit",
        sessionId: session.id,
        decision: "info",
        reason: "audit rows dropped: rate limit",
        detail: { dropped },
      }),
  });

  function countOf(sessionId: string): InvalidCount {
    let count = invalid.get(sessionId);
    if (!count) {
      if (invalid.size >= MAX_TRACKED_SESSIONS) {
        const oldest = invalid.keys().next();
        if (!oldest.done) invalid.delete(oldest.value);
      }
      count = { stored: 0, dropped: 0, loggedAt: Number.NEGATIVE_INFINITY };
      invalid.set(sessionId, count);
    }
    return count;
  }

  function noteInvalid(session: { id: string; ownerId: string }): void {
    const count = countOf(session.id);
    const now = clock.now();
    const stored =
      count.stored < MAX_INVALID_PER_SESSION &&
      tryAppend({
        at: now,
        ownerId: session.ownerId,
        actor: "worker",
        kind: "invalid",
        sessionId: session.id,
        decision: "info",
        reason: "malformed audit record",
      });
    if (stored) count.stored++;
    else count.dropped++;
    if (now - count.loggedAt >= LOG_EVERY_MS) {
      count.loggedAt = now;
      logger.warn("audit_record_invalid", { sessionId: session.id, dropped: count.dropped });
    }
  }

  function rowOf(session: { id: string; ownerId: string }, entry: PolicyAuditEntry): AuditInsert {
    const base = {
      at: clock.now(),
      ownerId: session.ownerId,
      actor: "worker",
      sessionId: session.id,
    } as const;
    switch (entry.kind) {
      case "call":
        return {
          ...base,
          kind: "call",
          toolCallId: entry.toolCallId,
          ...(entry.parentToolCallId === undefined ? {} : { parentToolCallId: entry.parentToolCallId }),
          tool: entry.tool,
          category: entry.category,
          decision: entry.decision,
          reason: entry.reason,
          stages: entry.stages,
          args: entry.args,
        };
      case "result":
        return {
          ...base,
          kind: "result",
          toolCallId: entry.toolCallId,
          ...(entry.parentToolCallId === undefined ? {} : { parentToolCallId: entry.parentToolCallId }),
          tool: entry.tool,
          decision: "info",
          stages: entry.stages,
          detail: { redactions: entry.redactions, external: entry.external },
        };
      case "session": {
        const fitted = fitToolNames(entry.tools, entry.tools.length, { mode: entry.mode });
        return {
          ...base,
          kind: "session",
          decision: "info",
          stages: entry.stages,
          detail: { ...fitted, truncated: fitted.truncated || entry.toolsTruncated },
        };
      }
    }
  }

  function decodedView(row: AuditRow): AuditView | null {
    const view = viewOf(row);
    if (AuditViewSchema.safeParse(view).success) return view;
    const now = clock.now();
    if (now - degradedLoggedAt >= LOG_EVERY_MS) {
      degradedLoggedAt = now;
      logger.warn("audit_row_degraded", { id: row.id });
    }
    const fixed = repaired(view);
    return AuditViewSchema.safeParse(fixed).success ? fixed : null;
  }

  return {
    append(line) {
      tryAppend({
        at: clock.now(),
        ownerId: line.ownerId,
        actor: line.actor,
        actorId: line.actorId,
        kind: line.kind,
        sessionId: line.sessionId,
        decision: "info",
        reason: clip(replaceNul(line.reason), REASON_MAX),
        detail: line.detail,
      });
    },
    fromWorker(session, raw, context) {
      const parsed = PolicyAuditEntrySchema.safeParse(raw);
      if (!parsed.success) {
        noteInvalid(session);
        return null;
      }
      const clean = replaceNul(parsed.data);
      const fact =
        clean.kind === "session"
          ? `worker scope ${context.containment === "scope" ? "on" : "off"}`
          : undefined;
      const stages = fitStages(clean.stages, fact);
      const entry: PolicyAuditEntry =
        clean.kind === "call"
          ? {
              ...clean,
              stages,
              args: scrubbed(clean.args, ARGS_MAX) ?? "",
              ...(clean.reason === undefined ? {} : { reason: scrubbed(clean.reason, REASON_MAX) ?? "" }),
            }
          : { ...clean, stages };
      if (budget.take(session)) tryAppend(rowOf(session, entry));
      return entry;
    },
    list(caller, params) {
      const limit = params.limit ?? DEFAULT_LIMIT;
      const rows = store.page({
        ownerId: caller.userId,
        sessionId: params.sessionId,
        before: params.before,
        limit,
      });
      const frame =
        PAGE_BYTES - sizeOf({ entries: [], nextBefore: Number.MAX_SAFE_INTEGER, truncated: true });
      const entries: AuditView[] = [];
      let used = 0;
      let truncated = false;
      for (const row of rows) {
        const view = decodedView(row);
        if (!view) continue;
        const size = sizeOf(view) + 1;
        if (used + size > frame) {
          truncated = true;
          break;
        }
        used += size;
        entries.push(view);
      }
      const more = truncated || rows.length >= limit;
      return { entries, nextBefore: more ? (entries.at(-1)?.id ?? null) : null, truncated };
    },
  };
}
