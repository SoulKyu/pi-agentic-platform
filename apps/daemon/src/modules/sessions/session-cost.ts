import type { SessionCost } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { SessionsStore } from "./store.ts";

/** At most one `cost` event per session in this window: the first goes out at once, then the latest at the window's end. */
export const COST_WINDOW_MS = 1000;
/** Sessions with an open window at most; one more publishes at once, so nothing is dropped and the timers stay bounded. */
export const COST_MAX_WINDOWS = 256;

export interface SessionCostSource {
  /** What the session has cost now, read at publish time; null when it has had no run. */
  costOf(sessionId: string): SessionCost | null;
}

export interface SessionCostPort {
  /** Late-bound: the runs service exists after the sessions module (`composeSessionCost`). */
  bind(source: SessionCostSource): void;
  /** The session's cost changed. `parent`: a run started or ended, so the parent session's total changed too. */
  changed(sessionId: string, opts?: { parent?: boolean }): void;
  /** The cost a fresh snapshot carries. */
  snapshotOf(sessionId: string): SessionCost | null;
  stop(): void;
}

export interface SessionCostDeps {
  readonly hub: Pick<StreamHub, "publish">;
  readonly clock: Clock;
  readonly store: Pick<SessionsStore, "get">;
  readonly logger: Pick<Logger, "warn">;
}

interface Window {
  readonly timer: TimerHandle;
  dirty: boolean;
}

/** UX-1 §4.4, ruling UX1-R7: the session's cost on its stream, read when published and never stored. */
export function createSessionCost(deps: SessionCostDeps): SessionCostPort {
  const { clock } = deps;
  const windows = new Map<string, Window>();
  let source: SessionCostSource | undefined;

  const read = (sessionId: string): SessionCost | null => {
    try {
      return source?.costOf(sessionId) ?? null;
    } catch (error) {
      deps.logger.warn("session_cost_failed", { err: error });
      return null;
    }
  };

  function publish(sessionId: string): boolean {
    const cost = read(sessionId);
    if (!cost) return false;
    deps.hub.publish("session", sessionId, { kind: "cost", cost });
    return true;
  }

  function open(sessionId: string): void {
    const timer = clock.setTimeout(() => {
      const window = windows.get(sessionId);
      windows.delete(sessionId);
      if (window?.dirty && publish(sessionId)) open(sessionId);
    }, COST_WINDOW_MS);
    windows.set(sessionId, { timer, dirty: false });
  }

  function change(sessionId: string): void {
    const window = windows.get(sessionId);
    if (window) {
      window.dirty = true;
      return;
    }
    if (!publish(sessionId)) return;
    if (windows.size < COST_MAX_WINDOWS) open(sessionId);
  }

  return {
    bind(next) {
      source = next;
    },
    changed(sessionId, opts) {
      change(sessionId);
      const parent = opts?.parent ? deps.store.get(sessionId)?.parentSessionId : undefined;
      if (parent) change(parent);
    },
    snapshotOf: read,
    stop() {
      for (const window of windows.values()) clock.clearTimeout(window.timer);
      windows.clear();
    },
  };
}
