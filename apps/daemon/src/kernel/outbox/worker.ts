import type { Clock, TimerHandle } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { guardTimer } from "../timer-guard.ts";
import type { OutboxHold } from "./hold.ts";
import {
  cancelEffect,
  cancelRequested,
  claimEffect,
  countUnknownKinds,
  DEADLINE_MS,
  dismissFailure,
  effectView,
  EFFECT_PAYLOADS,
  failedRow,
  type EffectKind,
  type EffectPayload,
  type EffectRow,
  type EffectView,
  listFailures,
  markSent,
  nextDue,
  nextWakeAt,
  type OutboxDb,
  purgeOutbox,
  recoverOutbox,
  type Settlement,
  settleEffect,
} from "./store.ts";

const MAX_IN_FLIGHT = 2;
/** A handler that has not returned this long after its abort is logged once (the row stays leased meanwhile). */
const OVERDUE_MS = 15_000;
const STOP_WAIT_MS = 20_000;
/** The next tick after a store error: a locked or failing database is retried slowly, never in a hot loop. */
const AFTER_ERROR_MS = 30_000;
const MAX_CLAIM_TRIES = 16;

export interface EffectContext {
  readonly effectId: number;
  readonly attempts: number;
  readonly ownerId: string | null;
  /** Aborted at `DEADLINE_MS[kind]` and at `stop()`: the handler ends its own bounded work and returns (M10R10). */
  readonly signal: AbortSignal;
  /** The point of no return (M10R149): call it right before the step that must never run twice. A test seam may return a promise to hold here; a handler awaits only a promise. */
  markSent(): void | Promise<void>;
  /** A cancel came while the effect was leased (M10R149): read it right before the point of no return. */
  cancelRequested(): boolean;
}
export type EffectHandler<K extends EffectKind> = (
  payload: EffectPayload<K>,
  context: EffectContext,
) => Promise<Settlement>;

export interface FailedEffect {
  readonly id: number;
  readonly kind: string;
  readonly ownerId: string | null;
  readonly lastError: string | null;
  readonly settledAt: number;
}

export interface Outbox {
  /** Once per kind, at composition; a second registration throws. */
  register<K extends EffectKind>(kind: K, handler: EffectHandler<K>): void;
  /** Boot, before anything else; `{ 0, 0 }` and nothing touched in read-only mode. */
  recover(): { retired: number; requeued: number; failed: number };
  /** Arms the Clock timer for the next due row; after `startServer`; a no-op in read-only mode. */
  start(): void;
  /** After a commit that enqueued something. */
  poke(): void;
  /** Tests: runs every due effect now (two kinds at once at most); how many ran. */
  drain(): Promise<number>;
  failures(ownerId: string): Array<{ id: number; kind: string; lastError: string | null; settledAt: number }>;
  /** An effect just settled as `failed` (its owner's banner; `ownerId` is null for a system effect). A throwing listener is logged. */
  onFailed(listener: (failure: FailedEffect) => void): () => void;
  /** An effect's handler is still running this long after its abort (its row stays leased). A throwing listener is logged. */
  onOverdue(listener: (overdue: { id: number; kind: string; ownerId: string | null }) => void): () => void;
  dismiss(ownerId: string, id: number): boolean;
  cancel(dedupKey: string): "retired" | "marked" | "none";
  /** The effect behind a receipt (a resume's, for the limit chip); null when there is none. */
  view(dedupKey: string): EffectView | null;
  purge(): number;
  /** No new lease; aborts every in-flight signal; awaits the handlers (20 s at most, then logs and returns); clears the timer. */
  stop(): Promise<void>;
  /** The caller's `Db`, for `enqueueEffect` inside its transaction. */
  readonly db: OutboxDb;
}

export interface OutboxDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  /**
   * Tests only (M10R80). `<kind>`: the row is claimed and launched as usual (it is `leased`), but the handler is not
   * called: the call waits for the abort (deadline or stop) and answers `retry("held")`. `<kind>:sent`: the handler runs
   * to its sent mark, which is written, and waits there for the abort; the step after the mark is never reached. A test
   * that kills the daemon meanwhile finds the leased row for the boot recovery.
   */
  readonly hold?: OutboxHold | null;
  /** One `outbox.<kind>` span per handler call (M10R92); the outcome is `ok` unless the row failed or will retry. */
  readonly span?: (kind: EffectKind) => { end(outcome: string): void };
}

type AnyHandler = (payload: unknown, context: EffectContext) => Promise<Settlement>;

interface InFlight {
  readonly kind: EffectKind;
  readonly ownerId: string | null;
  readonly controller: AbortController;
  deadline: TimerHandle | null;
  overdue: TimerHandle | null;
  done: Promise<void>;
}

const SETTLEMENTS = new Set(["done", "defer", "retry", "fail"]);
const isSettlement = (value: unknown): value is Settlement =>
  typeof value === "object" &&
  value !== null &&
  SETTLEMENTS.has((value as { outcome?: string }).outcome ?? "");

export function createOutbox(deps: OutboxDeps): Outbox {
  const { db, clock, logger, readOnly } = deps;
  const handlers = new Map<EffectKind, AnyHandler>();
  const busyKinds = new Set<string>();
  const inFlightIds = new Set<number>();
  const running = new Map<number, InFlight>();
  let timer: TimerHandle | null = null;
  let started = false;
  let stopped = false;
  let launches = 0;
  const failedListeners = new Set<(failure: FailedEffect) => void>();
  const overdueListeners = new Set<(overdue: { id: number; kind: string; ownerId: string | null }) => void>();

  const kinds = (): EffectKind[] => [...handlers.keys()];
  const guard = (name: string, work: () => void | Promise<void>): void =>
    void guardTimer(logger, name, work, clock);

  function cancelTimer(): void {
    if (timer) clock.clearTimeout(timer);
    timer = null;
  }

  function armIn(delay: number): void {
    timer = clock.setTimeout(() => {
      timer = null;
      tick();
    }, delay);
  }

  /** Arms the next wake; never throws. After a failed tick it waits `AFTER_ERROR_MS` instead of asking the store. */
  function arm(afterFailure = false): void {
    cancelTimer();
    if (!started || stopped || readOnly) return;
    if (afterFailure) return armIn(AFTER_ERROR_MS);
    if (running.size >= MAX_IN_FLIGHT) return;
    try {
      const at = nextWakeAt(db, kinds(), busyKinds);
      if (at !== null) armIn(Math.max(0, at - clock.now()));
    } catch (error) {
      logger.warn("outbox_arm_failed", { err: error });
      armIn(AFTER_ERROR_MS);
    }
  }

  function tick(): void {
    guard("outbox_loop", () => {
      let failed = true;
      try {
        pump();
        failed = false;
      } finally {
        arm(failed);
      }
    });
  }

  function abortEntry(id: number, entry: InFlight): void {
    if (entry.controller.signal.aborted) return;
    entry.controller.abort();
    entry.overdue = clock.setTimeout(
      () =>
        guard("outbox_overdue", () => {
          logger.warn("outbox_handler_overdue", { kind: entry.kind, effectId: id });
          for (const listener of [...overdueListeners]) {
            try {
              listener({ id, kind: entry.kind, ownerId: entry.ownerId });
            } catch (error) {
              logger.warn("outbox_overdue_listener_error", { err: error });
            }
          }
        }),
      OVERDUE_MS,
    );
  }

  function clearEntryTimers(entry: InFlight): void {
    if (entry.deadline) clock.clearTimeout(entry.deadline);
    if (entry.overdue) clock.clearTimeout(entry.overdue);
    entry.deadline = null;
    entry.overdue = null;
  }

  /** Runs the handler and settles the row with the handler's own result, once it returned. Never rejects. */
  async function execute(row: EffectRow, kind: EffectKind, entry: InFlight): Promise<void> {
    let settlement: Settlement;
    const span = deps.span?.(kind);
    try {
      settlement = await callHandler(row, kind, entry);
    } finally {
      clearEntryTimers(entry);
    }
    span?.end(settlement.outcome === "fail" || settlement.outcome === "retry" ? "error" : "ok");
    try {
      settleEffect(db, row.id, settlement, clock.now());
    } catch (error) {
      // The row stays leased; the next boot recovers it.
      logger.error("outbox_settle_failed", { kind, effectId: row.id, err: error });
    }
    if (failedListeners.size > 0) tellFailed(row.id);
    inFlightIds.delete(row.id);
    busyKinds.delete(kind);
    running.delete(row.id);
    if (started && !stopped) tick();
  }

  function tellFailed(id: number): void {
    try {
      const failure = failedRow(db, id);
      if (!failure) return;
      for (const listener of [...failedListeners]) {
        try {
          listener(failure);
        } catch (error) {
          logger.warn("outbox_failed_listener_error", { err: error });
        }
      }
    } catch (error) {
      logger.warn("outbox_failed_read_error", { err: error });
    }
  }

  async function callHandler(row: EffectRow, kind: EffectKind, entry: InFlight): Promise<Settlement> {
    const handler = handlers.get(kind);
    let payload: unknown;
    try {
      const parsed = EFFECT_PAYLOADS[kind].safeParse(JSON.parse(row.payload));
      if (parsed.success) payload = parsed.data;
    } catch {
      // Unparseable JSON is a bad payload like any other.
    }
    if (payload === undefined || !handler) return { outcome: "fail", code: "bad_payload" };
    if (kind === deps.hold) {
      const { signal } = entry.controller;
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      return { outcome: "retry", code: "held" };
    }
    const { signal } = entry.controller;
    const heldAfterMark = deps.hold === `${kind}:sent`;
    const context: EffectContext = {
      effectId: row.id,
      attempts: row.attempts,
      ownerId: row.ownerId,
      signal,
      // Synchronous unless the test seam holds here: a handler's checks and its next step stay in one tick.
      markSent: heldAfterMark
        ? async () => {
            markSent(db, row.id, clock.now());
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              );
            throw new Error("held after the sent mark");
          }
        : () => void markSent(db, row.id, clock.now()),
      cancelRequested: () => cancelRequested(db, row.id),
    };
    try {
      const result = await handler(payload, context);
      if (isSettlement(result)) return result;
      logger.warn("outbox_handler_result_invalid", { kind, effectId: row.id });
    } catch (error) {
      logger.warn("outbox_handler_error", { kind, effectId: row.id, err: error });
    }
    return { outcome: "retry", code: "handler_error" };
  }

  function launch(row: EffectRow, kind: EffectKind): void {
    inFlightIds.add(row.id);
    busyKinds.add(kind);
    launches++;
    const entry: InFlight = {
      kind,
      ownerId: row.ownerId,
      controller: new AbortController(),
      deadline: null,
      overdue: null,
      done: Promise.resolve(),
    };
    entry.deadline = clock.setTimeout(
      () => guard("outbox_deadline", () => abortEntry(row.id, entry)),
      DEADLINE_MS[kind],
    );
    running.set(row.id, entry);
    entry.done = execute(row, kind, entry);
  }

  /** Leases and starts due rows until two are in flight or none is eligible. Returns how many it started. */
  function pump(): number {
    if (stopped || readOnly) return 0;
    const before = launches;
    for (let tries = 0; running.size < MAX_IN_FLIGHT && tries < MAX_CLAIM_TRIES; tries++) {
      const now = clock.now();
      const row = nextDue(db, now, kinds(), busyKinds, inFlightIds);
      if (!row) break;
      const kind = row.kind as EffectKind;
      if (claimEffect(db, row.id, kind, now)) launch(row, kind);
    }
    return launches - before;
  }

  return {
    db,
    register(kind, handler) {
      if (handlers.has(kind)) throw new Error(`outbox handler already registered: ${kind}`);
      handlers.set(kind, handler as unknown as AnyHandler);
      if (started) arm();
    },
    recover() {
      if (readOnly) return { retired: 0, requeued: 0, failed: 0 };
      const result = recoverOutbox(db, clock.now());
      if (result.retired > 0 || result.requeued > 0 || result.failed > 0)
        logger.warn("outbox_recovered", result);
      const unknown = countUnknownKinds(db);
      if (unknown > 0) logger.warn("outbox_unknown_kinds", { count: unknown });
      return result;
    },
    start() {
      if (readOnly || started || stopped) return;
      started = true;
      arm();
    },
    poke() {
      if (!started || stopped || readOnly) return;
      cancelTimer();
      armIn(0);
    },
    async drain() {
      const before = launches;
      for (;;) {
        pump();
        if (running.size === 0) break;
        await Promise.race([...running.values()].map((entry) => entry.done));
      }
      return launches - before;
    },
    failures: (ownerId) => listFailures(db, ownerId),
    onFailed(listener) {
      failedListeners.add(listener);
      return () => void failedListeners.delete(listener);
    },
    onOverdue(listener) {
      overdueListeners.add(listener);
      return () => void overdueListeners.delete(listener);
    },
    dismiss: (ownerId, id) => !readOnly && dismissFailure(db, ownerId, id),
    cancel: (dedupKey) => (readOnly ? "none" : cancelEffect(db, dedupKey, clock.now())),
    view: (dedupKey) => effectView(db, dedupKey),
    purge: () => (readOnly ? 0 : purgeOutbox(db, clock.now())),
    async stop() {
      stopped = true;
      cancelTimer();
      for (const [id, entry] of running) abortEntry(id, entry);
      if (running.size === 0) return;
      const all = Promise.all([...running.values()].map((entry) => entry.done));
      let giveUp: TimerHandle | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        giveUp = clock.setTimeout(() => resolve("timeout"), STOP_WAIT_MS);
      });
      const outcome = await Promise.race([all.then(() => "done" as const), timeout]);
      if (giveUp) clock.clearTimeout(giveUp);
      if (outcome === "timeout") {
        logger.error("outbox_stop_timeout", { kinds: [...running.values()].map((entry) => entry.kind) });
        for (const entry of running.values()) clearEntryTimers(entry);
      }
    },
  };
}
