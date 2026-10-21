import type { EgressRefusedCardData } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VmRefusal } from "../egress/index.ts";

/** One card, one Inbox item and one push per agent and host:port per hour; later refusals only raise the card's count (spec §6). */
export const REFUSAL_WINDOW_MS = 3_600_000;
/** An agent that tries host after host gets at most this many new cards an hour; the rest are only logged. */
export const NEW_CARDS_PER_AGENT_HOUR = 20;
/** A card is updated (one DB write, one hint) at most this often; the count in memory is exact and the last one is flushed. */
export const UPDATE_EVERY_MS = 60_000;
/** One log line per agent and event per this window, with the number of lines it stands for. */
export const LOG_EVERY_MS = 60_000;
const MAX_LOG_KEYS = 256;

export interface RefusalSinkDeps {
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Pick<Logger, "warn">;
  ownerOf(agentId: string): string | null;
  readonly events: {
    write(
      ownerId: string,
      agentId: string,
      kind: "egress_refused",
      taskId: null,
      data: EgressRefusedCardData,
    ): number | null;
    update(ownerId: string, eventId: number, data: EgressRefusedCardData): boolean;
  };
  readonly items: {
    upsertAgentItem(input: {
      ownerId: string;
      kind: string;
      agentId: string;
      refId: string;
      detail: string;
      toHandle: false;
    }): boolean;
  };
}

interface Open {
  readonly ownerId: string;
  readonly eventId: number;
  data: EgressRefusedCardData;
  /** When the card was last written to the database. */
  writtenAt: number;
  timer: TimerHandle | null;
}

/**
 * Where the VM egress proxy's refusals go (AVM2-E4, E5): a card in the agent's thread and an Inbox item (whose push class is
 * `notify`). The state is in memory, keyed `agentId|host:port`; a daemon restart may notify once more. Never throws.
 */
export function createRefusalSink(deps: RefusalSinkDeps): (refusal: VmRefusal) => void {
  const open = new Map<string, Open>();
  const fresh = new Map<string, number[]>(); // agentId -> times of the cards written in the last hour

  const prune = (now: number): void => {
    for (const [key, entry] of open) if (now - entry.data.firstAt >= REFUSAL_WINDOW_MS) open.delete(key);
    for (const [agentId, times] of fresh) {
      const recent = times.filter((at) => now - at < REFUSAL_WINDOW_MS);
      if (recent.length === 0) fresh.delete(agentId);
      else fresh.set(agentId, recent);
    }
  };

  const logged = new Map<string, { at: number; skipped: number }>();
  const logOnce = (event: string, agentId: string, now: number): void => {
    const key = `${event}|${agentId}`;
    const before = logged.get(key);
    if (before && now - before.at < LOG_EVERY_MS) {
      before.skipped++;
      return;
    }
    if (logged.size >= MAX_LOG_KEYS)
      for (const [each, entry] of logged) if (now - entry.at >= LOG_EVERY_MS) logged.delete(each);
    logged.set(key, { at: now, skipped: 0 });
    deps.logger.warn(event, before?.skipped ? { agentId, suppressed: before.skipped } : { agentId });
  };

  /** The one database write of a card: its count so far. A card the database no longer holds is forgotten. */
  const flush = (key: string, entry: Open): void => {
    if (entry.timer !== null) deps.clock.clearTimeout(entry.timer);
    entry.timer = null;
    entry.writtenAt = deps.clock.now();
    if (!deps.events.update(entry.ownerId, entry.eventId, entry.data) && open.get(key) === entry)
      open.delete(key);
  };

  return (refusal) => {
    const now = deps.clock.now();
    const key = `${refusal.agentId}|${refusal.host}:${refusal.port}`;
    const known = open.get(key);
    if (known && now - known.data.firstAt < REFUSAL_WINDOW_MS) {
      known.data = {
        ...known.data,
        count: known.data.count + 1,
        lastAt: now,
        reason: refusal.reason,
        address: refusal.address,
      };
      if (now - known.writtenAt >= UPDATE_EVERY_MS) flush(key, known);
      else if (known.timer === null)
        known.timer = deps.clock.setTimeout(() => flush(key, known), known.writtenAt + UPDATE_EVERY_MS - now);
      return;
    }
    prune(now);
    const ownerId = deps.ownerOf(refusal.agentId);
    if (ownerId === null) {
      logOnce("egress_refusal_unknown_agent", refusal.agentId, now);
      return;
    }
    const recent = fresh.get(refusal.agentId) ?? [];
    if (recent.length >= NEW_CARDS_PER_AGENT_HOUR) {
      logOnce("egress_refusal_card_cap", refusal.agentId, now);
      return;
    }
    const data: EgressRefusedCardData = {
      host: refusal.host,
      port: refusal.port,
      reason: refusal.reason,
      address: refusal.address,
      source: refusal.source === "thread" ? "thread" : refusal.source.task,
      count: 1,
      firstAt: now,
      lastAt: now,
    };
    const eventId = deps.events.write(ownerId, refusal.agentId, "egress_refused", null, data);
    if (eventId === null) return;
    fresh.set(refusal.agentId, [...recent, now]);
    open.set(key, { ownerId, eventId, data, writtenAt: now, timer: null });
    deps.items.upsertAgentItem({
      ownerId,
      kind: "agent_egress",
      agentId: refusal.agentId,
      refId: String(eventId),
      detail: `${refusal.host}:${refusal.port}`,
      toHandle: false,
    });
  };
}
