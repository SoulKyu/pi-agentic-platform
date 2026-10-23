import {
  HEALTH_LIMITS,
  healthSeverityOf,
  type HealthEvent,
  type HealthKind,
  type HealthSeverity,
  type HealthSource,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { HealthEventInput } from "./events.ts";

/** What the buffer tells its listeners: a new row, or a re-fire of the row that collapsed. */
export type HealthChange =
  | { readonly kind: "event"; readonly ownerId: string; readonly event: HealthEvent }
  | {
      readonly kind: "collapse";
      readonly ownerId: string;
      readonly seq: number;
      readonly ts: number;
      readonly count: number;
    };

interface Row {
  readonly key: string;
  readonly seq: number;
  readonly ownerId: string;
  ts: number;
  readonly kind: HealthKind;
  readonly severity: HealthSeverity;
  readonly code: string;
  readonly sourceRef: HealthSource;
  count: number;
}

/** The client shape: `ownerId` and the identity key never leave the daemon. */
function toEvent(row: Row): HealthEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    severity: row.severity,
    code: row.code,
    sourceRef: row.sourceRef,
    count: row.count,
  };
}

export interface HealthPage {
  readonly events: HealthEvent[];
  readonly hasMore: boolean;
}

export function createHealthBuffer(deps: { readonly clock: Clock; readonly logger: Logger }) {
  const rows: Row[] = []; // newest first
  const byKey = new Map<string, Row>();
  let nextSeq = 1;
  const listeners = new Set<(change: HealthChange) => void>();
  const tell = (change: HealthChange) => {
    // same guard as createHealthEvents: one listener never stops the others nor the move that caused the change
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        deps.logger.warn("health_listener_failed", { kind: change.kind, err: error });
      }
    }
  };

  function record(input: HealthEventInput): void {
    const severity = healthSeverityOf(input.kind, input.code);
    if (severity === null)
      return void deps.logger.warn("health_unknown_code", { kind: input.kind, code: input.code });
    const key = `${input.ownerId}\0${input.kind}\0${input.code}\0${JSON.stringify(input.sourceRef)}`;
    const ts = deps.clock.now();
    const found = byKey.get(key);
    if (found) {
      // collapse: one row per identity is by construction the newest of that identity
      found.ts = ts;
      found.count += 1;
      return tell({ kind: "collapse", ownerId: input.ownerId, seq: found.seq, ts, count: found.count });
    }
    const row: Row = {
      key,
      seq: nextSeq++,
      ownerId: input.ownerId,
      ts,
      kind: input.kind,
      severity,
      code: input.code,
      sourceRef: input.sourceRef,
      count: 1,
    };
    rows.unshift(row);
    byKey.set(key, row);
    if (rows.length > HEALTH_LIMITS.buffer) {
      const dropped = rows.pop();
      if (dropped) byKey.delete(dropped.key);
    }
    tell({ kind: "event", ownerId: input.ownerId, event: toEvent(row) });
  }

  function page(ownerId: string, before?: number, limit?: number): HealthPage {
    const want = Math.min(limit ?? HEALTH_LIMITS.pageDefault, HEALTH_LIMITS.pageMax);
    // ponytail: O(500) filter per page, the buffer is bounded by construction
    const matches = rows.filter(
      (row) => row.ownerId === ownerId && (before === undefined || row.seq < before),
    );
    let used = 0;
    let hasMore = matches.length > want;
    const events: HealthEvent[] = [];
    for (const row of matches) {
      if (events.length >= want) break;
      const event = toEvent(row);
      const size = sizeOf(event) + 1;
      if (used + size > PAGE_BYTES) {
        hasMore = true; // the frame budget (M2R54)
        break;
      }
      used += size;
      events.push(event);
    }
    // a page that fit nothing (a single event over the frame budget) says hasMore: false, never an empty loop
    return { events, hasMore: events.length > 0 && hasMore };
  }

  return {
    record,
    page,
    snapshot: (ownerId: string) => ({ kind: "snapshot" as const, ...page(ownerId) }),
    on: (listener: (change: HealthChange) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
