import { AUTOMATION_LIMITS, type AutomationSettings } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Span } from "../../kernel/observability/tracer.ts";
import type { EffectContext, Settlement } from "../../kernel/outbox/index.ts";
import type { FeedFetchResult } from "./feed-fetch.ts";
import { type FeedEntry, parseFeed } from "./feed-parse.ts";
import { hasBaseline, markSeen, seenKeys, takeBaseline } from "./feed-seen.ts";
import type { FireInput, FireResult } from "./fire.ts";
import { writeJournal } from "./fire-journal.ts";
import type { Gates } from "./gates.ts";
import type { HealthEvents } from "../health/index.ts";
import { refuseStoredPrecheck } from "./precheck-refusal.ts";
import type { TriggerRecord } from "./triggers.ts";

export interface FeedPollDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly triggers: {
    get(ownerId: string, id: string): TriggerRecord | null;
    getAt(ownerId: string, id: string, revision: number): TriggerRecord | null;
  };
  /** The pause and the budget are read before the fetch: a paused or over-budget owner is not polled. */
  readonly settings: { automation(ownerId: string): AutomationSettings };
  readonly gates: Pick<Gates, "over">;
  /** The one fire path (M10R34). */
  fire(triggerId: string, revision: number, input: FireInput): FireResult;
  /** The signal destroys the socket (M10R73). */
  fetch(url: string, signal: AbortSignal): Promise<FeedFetchResult>;
  /** The health events (Task 3): a feed failure the owner may page on. */
  readonly health?: Pick<HealthEvents, "emit">;
  /** One `feed.fetch` span per poll that fetched; only closed values are given to it (numbers, `ok`, `error`). */
  readonly span?: () => Span;
}

const done: Settlement = { outcome: "done" };
const deadline: Settlement = { outcome: "retry", code: "deadline" };
const SIZE_BUCKETS = [1_024, 16_384, 262_144, 1_048_576] as const;

/** The entry as the model reads it: one `name: value` line per field, no empty field. */
function entryText(entry: FeedEntry): string {
  return [
    `title: ${entry.title}`,
    entry.link === null ? "" : `link: ${entry.link}`,
    entry.date === null ? "" : `date: ${entry.date}`,
    entry.summary === "" ? "" : `summary: ${entry.summary}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Newest first by date when every entry has a readable one; otherwise the feed's own order (feeds list newest first). */
function newestFirst(entries: FeedEntry[]): FeedEntry[] {
  const times = entries.map((entry) => (entry.date === null ? Number.NaN : Date.parse(entry.date)));
  if (times.some((time) => Number.isNaN(time))) return entries;
  return entries
    .map((entry, index) => ({ entry, time: times[index] as number, index }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map((one) => one.entry);
}

/**
 * The `feed.poll` effect (M10R73, M10R76): fetch, parse, keep the entries not seen before, refuse a stored precheck, then fire once
 * with the newest ten, fenced. Entries are marked seen in the transaction of the fire that used them, so a crash or a
 * refusal (pause, budget, full queue, a trigger saved meanwhile) leaves them new for the next poll. The first poll of an
 * address marks everything seen and fires nothing.
 */
export function createFeedPoller(deps: FeedPollDeps) {
  const { db, clock, logger } = deps;
  const stopper = new AbortController();

  function journal(
    record: TriggerRecord,
    verdict: "dedup" | "error" | "precheck" | "paused" | "budget",
    detail: string | null,
  ): void {
    db.transaction(() =>
      writeJournal(db, {
        triggerId: record.id,
        ownerId: record.ownerId,
        source: "feed",
        verdict,
        detail,
        taskId: null,
        dedupKey: null,
        at: clock.now(),
      }),
    );
  }

  /** The first poll of an address: only if the trigger is still the one that was read. */
  function baseline(record: TriggerRecord, url: string, entries: FeedEntry[]): Settlement {
    if (deps.triggers.getAt(record.ownerId, record.id, record.revision) === null) {
      if (deps.triggers.get(record.ownerId, record.id) !== null) journal(record, "error", "changed");
      return done;
    }
    db.transaction(() => {
      takeBaseline(
        db,
        record.id,
        url,
        entries.map((entry) => entry.key),
        clock.now(),
      );
      writeJournal(db, {
        triggerId: record.id,
        ownerId: record.ownerId,
        source: "feed",
        verdict: "dedup",
        detail: `first poll · ${entries.length} entries`,
        taskId: null,
        dedupKey: null,
        at: clock.now(),
      });
    });
    return done;
  }

  /** The health event of a failed poll: next to the log or the journal line, never instead of it. */
  function feedHealth(record: TriggerRecord, code: string): void {
    deps.health?.emit({
      ownerId: record.ownerId,
      kind: "feed",
      code,
      sourceRef: { kind: "trigger", id: record.id, name: record.name },
    });
  }

  async function poll(
    ownerId: string | null,
    triggerId: string,
    effectSignal: AbortSignal,
  ): Promise<Settlement> {
    const record = ownerId === null ? null : deps.triggers.get(ownerId, triggerId);
    const source = record?.input?.source;
    // A disabled or deleted trigger is never fetched (zero telemetry, M10R73).
    if (!record || !record.enabled || source?.type !== "feed") return done;
    // A paused or over-budget owner is not polled: the fire would be refused anyway, so nothing is fetched. The next poll
    // is already stored; the entries stay new for the poll after the owner resumes (M10R73).
    const held = deps.settings.automation(record.ownerId).paused
      ? "paused"
      : deps.gates.over(record.ownerId, record.id)
        ? "budget"
        : null;
    if (held !== null) {
      journal(record, held, null);
      return done;
    }
    const signal = AbortSignal.any([effectSignal, stopper.signal]);

    const span = deps.span?.();
    const started = clock.now();
    let fetched: FeedFetchResult;
    try {
      fetched = await deps.fetch(source.url, signal);
    } catch (error) {
      // The message of a network error can hold the address: only its class is logged.
      logger.warn("feed_poll_failed", {
        triggerId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      feedHealth(record, "feed_network");
      span?.end("error");
      return { outcome: "retry", code: "feed_error" };
    }
    const bytes = fetched.ok ? Buffer.byteLength(fetched.body) : 0;
    const statusOf = fetched.ok ? 200 : Number(/^feed_status_(\d+)$/.exec(fetched.code)?.[1] ?? 0);
    logger.info("feed_fetch", {
      triggerId,
      status: statusOf,
      bytes,
      durationMs: clock.now() - started,
      code: fetched.ok ? "ok" : fetched.code,
    });
    const closeSpan = (count: number): void =>
      span?.end(fetched.ok ? "ok" : "error", {
        status: Math.floor(statusOf / 100),
        bytes: SIZE_BUCKETS.find((bucket) => bytes <= bucket) ?? SIZE_BUCKETS[3],
        count,
      });
    if (signal.aborted) {
      closeSpan(0);
      return deadline;
    }
    if (!fetched.ok) {
      closeSpan(0);
      journal(record, "error", fetched.code);
      feedHealth(record, fetched.code);
      return fetched.retry
        ? { outcome: "retry", code: fetched.code }
        : { outcome: "fail", code: fetched.code };
    }
    const parsed = parseFeed(fetched.body);
    if (!parsed.ok) {
      closeSpan(0);
      journal(record, "error", parsed.code);
      feedHealth(record, parsed.code);
      return { outcome: "fail", code: parsed.code };
    }
    closeSpan(parsed.entries.length);

    const { entries } = parsed;
    if (!hasBaseline(db, record.id, source.url)) return baseline(record, source.url, entries);
    const seen = seenKeys(
      db,
      record.id,
      entries.map((entry) => entry.key),
    );
    const unique = new Map(
      entries.filter((entry) => !seen.has(entry.key)).map((entry) => [entry.key, entry]),
    );
    const fresh = newestFirst([...unique.values()]);
    if (fresh.length === 0) return done;
    const chosen = fresh.slice(0, AUTOMATION_LIMITS.feedEntriesPerTask);

    if (refuseStoredPrecheck(deps, record, "feed")) return done;

    const skipped = fresh.length - chosen.length;
    db.transaction(() => {
      const result = deps.fire(record.id, record.revision, {
        ownerId: record.ownerId,
        source: "feed",
        payload: { text: chosen.map(entryText).join("\n\n"), source: "feed" },
        dedupKey: null,
        title: record.name,
        detail: chosen[0]?.title ?? null,
        gated: true,
        gates: { exemptDisabled: false },
        retry: null,
      });
      if (result.verdict !== "fired") return;
      markSeen(
        db,
        record.id,
        fresh.map((entry) => entry.key),
        clock.now(),
      );
      if (skipped > 0) journal(record, "dedup", `${skipped} more skipped`);
    });
    return done;
  }

  return {
    /** Registered once for `feed.poll`. Never throws; the outbox settles the row with what it returns. */
    handler: (
      payload: { triggerId: string },
      context: Pick<EffectContext, "ownerId" | "signal">,
    ): Promise<Settlement> => poll(context.ownerId, payload.triggerId, context.signal),
    /** `automation.stop()`: fetches in flight are aborted. */
    stop(): void {
      stopper.abort();
    },
  };
}
