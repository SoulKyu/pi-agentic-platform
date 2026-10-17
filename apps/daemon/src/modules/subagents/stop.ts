import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { RunEndEvent } from "../runs/index.ts";
import type { SubagentStore } from "./store.ts";

/** Why a child was stopped, as its row records it (`subagent_runs.reason`). */
export type StopReason =
  "stopped" | "timeout" | "parent_run_ended" | "parent_archived" | "parent_deleted" | "quarantined";

export interface StopDeps {
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
  readonly store: SubagentStore;
  readonly sessions: {
    abort(ownerId: string, sessionId: string): Promise<void>;
    /** The agent a parent session belongs to; null for a plain or lane session. */
    agentOf(parentSessionId: string): string | null;
  };
  readonly runs: { clearExpected(sessionId: string): void };
}

/** What the parent's held call waits on besides its child: the moment something stops the child. */
export interface StopGuard {
  /** Resolves with the cause once the child was stopped; never resolves for a child that ended by itself. */
  readonly cancelled: Promise<StopReason>;
  stopped(): boolean;
  /** Stops the child now, for a cause the guard cannot see itself (the parent was archived while the child was made). */
  stop(reason: StopReason): void;
  /** The call is over: nothing stops this child any more. */
  release(): void;
}

interface Held {
  readonly rowId: string;
  readonly ownerId: string;
  readonly parentId: string;
  readonly childId: string;
  readonly stop: (reason: StopReason) => void;
}

/** How a cancelled call is recorded: the op's deadline (the dispatcher aborts with `timeout`) or the parent's stop. */
const callReason = (signal: AbortSignal): "timeout" | "stopped" =>
  signal.reason === "timeout" ? "timeout" : "stopped";

/**
 * M11R139: a child is aborted when (a) the parent tool's signal aborts, (b) the parent's run ends while it runs, (c) the parent
 * session is archived or deleted, (d) its agent is quarantined, (e) the daemon stops (the boot sweep). Every cause ends the
 * row `cancelled` with its reason, aborts the child's worker (its open dialogs close with the run, M2) and clears the origin
 * the child's first run was waiting for; the parent's held call then answers `cancelled`. A child stops once.
 */
export function createSubagentStop(deps: StopDeps) {
  const { store, sessions } = deps;
  const logger = deps.logger.child({ component: "subagent_stop" });
  const held = new Map<string, Held>();

  function guard(input: {
    rowId: string;
    ownerId: string;
    parentId: string;
    childId: string;
    signal: AbortSignal;
  }): StopGuard {
    const { rowId, ownerId, parentId, childId, signal } = input;
    let cause: StopReason | null = null;
    let resolve: (reason: StopReason) => void = () => undefined;
    const cancelled = new Promise<StopReason>((done) => {
      resolve = done;
    });
    const stop = (reason: StopReason): void => {
      cause = reason;
      held.delete(rowId);
      signal.removeEventListener("abort", onAbort);
      // The worker and the held call first: a row that cannot be written must not keep the child running (review M2).
      deps.runs.clearExpected(childId);
      sessions.abort(ownerId, childId).catch((error: unknown) => {
        logger.warn("subagent_abort_failed", { childId, reason, err: error });
      });
      resolve(reason);
      try {
        store.finish(rowId, "cancelled", reason, deps.clock.now());
      } catch (error) {
        logger.warn("subagent_row_not_ended", { childId, reason, err: error });
      }
    };
    const onAbort = (): void => stop(callReason(signal));
    held.set(rowId, { rowId, ownerId, parentId, childId, stop });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return {
      cancelled,
      stopped: () => cause !== null,
      stop: (reason) => {
        if (cause === null) stop(reason);
      },
      release() {
        held.delete(rowId);
        signal.removeEventListener("abort", onAbort);
      },
    };
  }

  const stopWhere = (reason: StopReason, matches: (entry: Held) => boolean): number => {
    const targets = [...held.values()].filter(matches);
    for (const entry of targets) entry.stop(reason);
    return targets.length;
  };

  return {
    guard,
    /** (b), (c): every running child of the parent. Returns how many were stopped. */
    cancelParent: (
      parentId: string,
      reason: "parent_run_ended" | "parent_archived" | "parent_deleted",
    ): number => stopWhere(reason, (entry) => entry.parentId === parentId),
    /** (f): the owner's Stop on one run. False when that run is not running, or is not the owner's. */
    cancelRun(ownerId: string, runId: string): boolean {
      const entry = held.get(runId);
      if (entry?.ownerId !== ownerId) return false;
      entry.stop("stopped");
      return true;
    },
    /** (d): every running child of the owner's agent threads of `agentId` (quarantine step 2). */
    cancelAgent: (ownerId: string, agentId: string): number =>
      stopWhere(
        "quarantined",
        (entry) => entry.ownerId === ownerId && sessions.agentOf(entry.parentId) === agentId,
      ),
    /** (b): the parent's run end, from the runs registry. Returns what unsubscribes. */
    watch(onRunEnd: (listener: (event: RunEndEvent) => void) => () => void): () => void {
      return onRunEnd(
        (event) => void stopWhere("parent_run_ended", (entry) => entry.parentId === event.sessionId),
      );
    },
    /** (e): no child survives a daemon that stopped, so no row may keep counting against its parent. */
    boot(): number {
      const count = store.interruptLive(deps.clock.now());
      if (count > 0) logger.info("subagent_runs_interrupted", { count });
      return count;
    },
  };
}
export type SubagentStop = ReturnType<typeof createSubagentStop>;
