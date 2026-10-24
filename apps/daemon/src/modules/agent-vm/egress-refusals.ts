import { boxKey, type EgressRefusedCardData } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VmRefusal } from "../egress/index.ts";

/** One card, one Inbox item and one push per box and host:port per hour; later refusals only raise the card's count (spec §6). */
export const REFUSAL_WINDOW_MS = 3_600_000;
/** A box that tries host after host gets at most this many new cards an hour; the rest are only logged. */
export const NEW_CARDS_PER_AGENT_HOUR = 20;
/** A card is updated (one DB write, one hint) at most this often; the count in memory is exact and the last one is flushed. */
export const UPDATE_EVERY_MS = 60_000;
/** One log line per box and event per this window, with the number of lines it stands for. */
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
 * `notify`). The state is in memory, keyed `boxKey|host:port`; only an agent's box has a thread to put a card in (a project box's cards come with its sessions, task A7); a daemon restart may notify once more. Never throws.
 */
export function createRefusalSink(deps: RefusalSinkDeps): (refusal: VmRefusal) => void {
  const open = new Map<string, Open>();
  const fresh = new Map<string, number[]>(); // boxKey -> times of the cards written in the last hour

  const prune = (now: number): void => {
    for (const [key, entry] of open) if (now - entry.data.firstAt >= REFUSAL_WINDOW_MS) open.delete(key);
    for (const [box, times] of fresh) {
      const recent = times.filter((at) => now - at < REFUSAL_WINDOW_MS);
      if (recent.length === 0) fresh.delete(box);
      else fresh.set(box, recent);
    }
  };

  const logged = new Map<string, { at: number; skipped: number; timer: TimerHandle | null }>();
  /** One line per window; the lines it hid are counted on the line after it, or, when none comes, by the timer at the window's end. */
  const logOnce = (event: string, box: string, now: number): void => {
    const key = `${event}|${box}`;
    const before = logged.get(key);
    if (before && now - before.at < LOG_EVERY_MS) {
      before.skipped++;
      before.timer ??= deps.clock.setTimeout(
        () => {
          if (logged.get(key) === before) logged.delete(key);
          deps.logger.warn(event, { box, suppressed: before.skipped });
        },
        before.at + LOG_EVERY_MS - now,
      );
      return;
    }
    if (before?.timer) deps.clock.clearTimeout(before.timer);
    if (logged.size >= MAX_LOG_KEYS)
      for (const [each, entry] of logged)
        if (now - entry.at >= LOG_EVERY_MS && entry.timer === null) logged.delete(each);
    logged.set(key, { at: now, skipped: 0, timer: null });
    deps.logger.warn(event, before?.skipped ? { box, suppressed: before.skipped } : { box });
  };

  /** The one database write of a card: its count so far. A card the database no longer holds is forgotten; a write that throws keeps the count for the next one. */
  const flush = (key: string, entry: Open): void => {
    if (entry.timer !== null) deps.clock.clearTimeout(entry.timer);
    entry.timer = null;
    entry.writtenAt = deps.clock.now();
    try {
      if (!deps.events.update(entry.ownerId, entry.eventId, entry.data) && open.get(key) === entry)
        open.delete(key);
    } catch {
      logOnce("egress_refusal_flush_failed", key.split("|")[0] ?? key, entry.writtenAt);
    }
  };

  return (refusal) => {
    const now = deps.clock.now();
    const box = boxKey(refusal.box);
    const key = `${box}|${refusal.host}:${refusal.port}`;
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
    if (refusal.box.kind !== "agent") {
      logOnce("egress_refusal_no_thread", box, now);
      return;
    }
    const agentId = refusal.box.id;
    const ownerId = deps.ownerOf(agentId);
    if (ownerId === null) {
      logOnce("egress_refusal_unknown_agent", box, now);
      return;
    }
    const recent = fresh.get(box) ?? [];
    if (recent.length >= NEW_CARDS_PER_AGENT_HOUR) {
      logOnce("egress_refusal_card_cap", box, now);
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
    const eventId = deps.events.write(ownerId, agentId, "egress_refused", null, data);
    if (eventId === null) return;
    fresh.set(box, [...recent, now]);
    open.set(key, { ownerId, eventId, data, writtenAt: now, timer: null });
    deps.items.upsertAgentItem({
      ownerId,
      kind: "agent_egress",
      agentId,
      refId: String(eventId),
      detail: `${refusal.host}:${refusal.port}`,
      toHandle: false,
    });
  };
}
