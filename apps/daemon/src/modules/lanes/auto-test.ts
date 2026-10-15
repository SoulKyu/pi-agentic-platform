import type { Logger } from "../../kernel/logger.ts";
import type { AfterRunListener } from "./checkpoints.ts";
import type { ScriptRunner } from "./scripts.ts";
import type { LaneNotices } from "./notices.ts";
import type { LaneRow, LanesStore } from "./store.ts";

export interface AutoTestDeps {
  readonly store: Pick<LanesStore, "get">;
  readonly notices: Pick<LaneNotices, "add">;
  readonly scripts: Pick<ScriptRunner, "run">;
  /** Whether a session of the lane, an archived one included, has read content from outside (M9R119). */
  tainted(lane: LaneRow): boolean;
  readonly logger: Logger;
  readonly readOnly: boolean;
  /** The lane's test state changed: its view goes out. */
  publish(laneId: string): void;
}

/**
 * The one place a script starts without a click (M9R84): a fan-out lane's approved `test:` script, once, when its
 * primary session's first run ends, and only if the lane was made by the owner's browser, does not come from an issue
 * and has no tainted session at that moment. Otherwise nothing runs and the compare chip says "Run tests", whose click
 * goes through the tainted confirmation. The runner runs only the exact text the owner approved, under the unattended
 * environment and the test deadline, so a lane with no approved test (or a changed one) simply does not start.
 */
export function autoTestListener(deps: AutoTestDeps): AfterRunListener {
  const started = new Set<string>();
  return (lane, info) => {
    if (deps.readOnly) return;
    if (lane.fanoutId === null || info.sessionId !== lane.primarySessionId) return;
    // The row was read before the run's end was written: a later run already sees its time.
    if (lane.firstRunEndedAt !== null || started.has(lane.id)) return;
    if (lane.createdBy !== "session" || lane.source?.kind === "issue") return;
    if (deps.tainted(lane)) return;
    started.add(lane.id);
    const ref = {
      id: lane.id,
      ownerId: lane.ownerId,
      projectRoot: lane.projectRoot,
      worktree: lane.worktree,
    };
    // Judged again at the spawn, after any wait in the runner's queue: the lane may have been tainted, archived or
    // otherwise changed since (the same four conditions, on the row as it is then).
    const guard = (): boolean => {
      const now = deps.store.get(lane.id);
      return (
        now !== undefined &&
        now.state === "active" &&
        now.createdBy === "session" &&
        now.source?.kind !== "issue" &&
        !deps.tainted(now)
      );
    };
    deps.scripts
      .run(ref, "test", { guard, dropped: () => deps.notices.add(lane.id, "auto_test_dropped") })
      .then(
        () => deps.publish(lane.id),
        (error: unknown) => deps.logger.warn("lane_auto_test_failed", { laneId: lane.id, err: error }),
      );
  };
}
