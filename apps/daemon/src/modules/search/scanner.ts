import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { isIndexDamaged } from "./index-db.ts";
import type { SearchIndexStore } from "./index-store.ts";
import { createScanEngine } from "./scanner-engine.ts";
import type { FileContext, FileOutcome } from "./scanner-file.ts";
import { codeOf, type ReconcileState, reconcilePass } from "./scanner-reconcile.ts";
import type { WatchFactory } from "./watch.ts";

export const RECONCILE_MS = 60_000;
export const RECONCILE_SOON_MS = 1_000;
/** `stop()` waits this long for the running pass and the running step, then moves on (they check `stopped`). */
export const STOP_WAIT_MS = 5_000;

export interface Scanner {
  start(): void;
  stop(): Promise<void>;
  /** Resolves when no reconcile pass and no step runs (tests). */
  idle(): Promise<void>;
  reconcile(): Promise<void>;
}

export function createScanner(deps: {
  readonly root: string;
  readonly installedAt: number;
  readonly store: SearchIndexStore;
  readonly sessions: Pick<SessionsScanPort, "claim" | "touched" | "named" | "previewed">;
  readonly watch: WatchFactory;
  readonly clock: Clock;
  readonly logger: Logger;
  onDamaged(): void;
  readonly yieldNow?: () => Promise<void>;
  readonly process?: (path: string, ctx: FileContext) => FileOutcome;
  readonly maxQueue?: number;
  readonly maxStats?: number;
}): Scanner {
  const limiter = createRateLimiter(deps.clock, 60_000);
  // Called from catch blocks and timers: a broken logger must not turn into an unhandled rejection.
  const say = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      const said = limiter.check(event);
      if (said.allowed) deps.logger.warn(event, { ...fields, suppressed: said.suppressed });
    } catch {
      // Nothing is left to tell.
    }
  };
  const yieldNow = deps.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const ctx: FileContext = {
    installedAt: deps.installedAt,
    store: deps.store,
    sessions: deps.sessions,
    logger: deps.logger,
    say,
  };
  let stopped = true;
  /** A stopped scanner cannot start again: a rebuild makes a new one. */
  let closed = false;
  let reconcileTimer: TimerHandle | null = null;
  let soonTimer: TimerHandle | null = null;
  let reconciling: Promise<void> | null = null;
  const state: ReconcileState = { at: 0, folders: new Set() };
  const failed = (error: unknown) => say("session_reconcile_failed", { code: codeOf(error) });
  const damaged = () => {
    try {
      deps.onDamaged();
    } catch (error) {
      say("session_damaged_callback_failed", { code: codeOf(error) });
    }
  };

  // One pass at a time; its failure is said, never thrown: a rejection nobody awaits would end the daemon (M4R74).
  const runReconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    reconciling ??= reconcilePass({
      root: deps.root,
      store: deps.store,
      engine,
      yieldNow,
      stopped: () => stopped,
      say,
      state,
      ...(deps.maxStats === undefined ? {} : { maxStats: deps.maxStats }),
    })
      .catch((error: unknown) => {
        say("session_list_failed", { code: codeOf(error) });
        if (isIndexDamaged(error)) damaged();
      })
      .finally(() => {
        reconciling = null;
      });
    return reconciling;
  };

  // Coalesced: the engine asks on every event past the debounce cap and on every nameless event.
  const reconcileSoon = () => {
    if (stopped || soonTimer) return;
    soonTimer = deps.clock.setTimeout(() => {
      soonTimer = null;
      runReconcile().catch(failed);
    }, RECONCILE_SOON_MS);
  };

  const engine = createScanEngine({
    root: deps.root,
    ctx,
    watch: deps.watch,
    clock: deps.clock,
    logger: deps.logger,
    say,
    requestReconcile: reconcileSoon,
    onDamaged: damaged,
    yieldNow,
    ...(deps.process ? { process: deps.process } : {}),
    ...(deps.maxQueue === undefined ? {} : { maxQueue: deps.maxQueue }),
  });

  const armReconcile = () => {
    if (stopped) return;
    reconcileTimer = deps.clock.setTimeout(() => {
      reconcileTimer = null;
      runReconcile().then(armReconcile).catch(failed);
    }, RECONCILE_MS);
  };

  /** Waits for `work`, but not longer than `STOP_WAIT_MS`: a pass stuck in the file system must not hold the daemon. */
  const bounded = async (work: Promise<unknown>, what: string): Promise<void> => {
    let timer: TimerHandle | null = null;
    const slow = new Promise<void>((resolve) => {
      timer = deps.clock.setTimeout(() => {
        say("session_scanner_stop_slow", { what, ms: STOP_WAIT_MS });
        resolve();
      }, STOP_WAIT_MS);
    });
    try {
      await Promise.race([work.catch(failed), slow]);
    } finally {
      if (timer) deps.clock.clearTimeout(timer);
    }
  };

  return {
    start() {
      if (!stopped || closed) return;
      stopped = false;
      engine.watchRoot();
      runReconcile().catch(failed);
      armReconcile();
    },
    async stop() {
      stopped = true;
      closed = true;
      if (reconcileTimer) deps.clock.clearTimeout(reconcileTimer);
      if (soonTimer) deps.clock.clearTimeout(soonTimer);
      reconcileTimer = null;
      soonTimer = null;
      // A pass checks `stopped` after each await: it ends at its next step, then nothing touches the store (M4R74).
      if (reconciling) await bounded(reconciling, "reconcile");
      await bounded(engine.close(), "engine");
    },
    async idle() {
      await reconciling;
      await engine.idle();
    },
    reconcile: runReconcile,
  };
}
