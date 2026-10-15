import { EntryId, LANE_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import {
  captureCheckpoint,
  checkpointRef,
  laneRefs,
  restoreCheckpoint,
} from "../../kernel/git/checkpoint.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { snapshotTree } from "../../kernel/git/snapshot.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LaneRunHooks, LaneRunInfo, SessionsLanePort } from "../sessions/index.ts";
import type { LaneLock } from "./lane-lock.ts";
import type { LaneNotices } from "./notices.ts";
import type { LanePathsIndex } from "./paths.ts";
import type { LaneRow, LanesStore } from "./store.ts";

/** The kernel's checkpoint functions, as one seam so unit tests can drive the order of events. */
export interface CheckpointKernel {
  refs: typeof laneRefs;
  capture: typeof captureCheckpoint;
  restore: typeof restoreCheckpoint;
  snapshot: typeof snapshotTree;
}
export const REAL_KERNEL: CheckpointKernel = {
  refs: laneRefs,
  capture: captureCheckpoint,
  restore: restoreCheckpoint,
  snapshot: snapshotTree,
};

/** What the captures and the restore share: git (guarded, with `indexDir`), the lane's stored git dir and the lock. */
export interface CheckpointBase {
  readonly git: GitRunner;
  readonly kernel?: CheckpointKernel;
  /** The runner accepts a temporary `GIT_INDEX_FILE` only in this folder. */
  readonly indexDir: string;
  /** The git dir pap stored for the lane (MC3 I3). */
  gitDirOf(worktree: string): string | undefined;
  lock(laneId: string): LaneLock;
  readonly notices: Pick<LaneNotices, "add">;
  /** Throws when the filesystem of the lane is too full (M9R117). */
  diskFloor(path: string): undefined;
  readonly sessions: () =>
    Pick<SessionsLanePort, "runState" | "activityIn" | "sessionIdsIn" | "branchPath"> | undefined;
  refreshFacts(laneId: string): Promise<void>;
  publish(laneId: string): void;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
}

export interface CheckpointDeps extends CheckpointBase {
  readonly store: Pick<LanesStore, "get" | "markFirstRunEnded">;
  readonly paths: Pick<LanePathsIndex, "laneOf">;
}

export type AfterRunListener = (lane: LaneRow, info: LaneRunInfo) => void;

export interface Checkpoints {
  readonly beforePrompt: LaneRunHooks["beforePrompt"];
  readonly afterRun: LaneRunHooks["afterRun"];
  /** The lane holds `checkpointsPerLane` checkpoints: captures are refused until it is archived. */
  full(laneId: string): boolean;
  /** Runs after every "after" capture (Task 18b joins here). */
  onAfterRun(listener: AfterRunListener): void;
  forget(laneId: string): void;
  /** Every capture started so far has ended. */
  settled(): Promise<void>;
}

/**
 * The lanes side of the run hooks (M9R73). Both captures run under the lane lock, never write the real index, HEAD or a
 * branch, and never throw into the prompt: a capture that fails is logged and the prompt goes on. A hook answers
 * `undefined` synchronously when it has nothing to do (the busy rule of M2R88).
 */
export function createCheckpoints(deps: CheckpointDeps): Checkpoints {
  const kernel = deps.kernel ?? REAL_KERNEL;
  const full = new Set<string>();
  const ended = new Set<string>();
  const listeners: AfterRunListener[] = [];
  const inflight = new Set<Promise<unknown>>();

  const laneFor = (info: LaneRunInfo): LaneRow | null => {
    // Where the folder is comes from the paths index; the state from the store (the index is rebuilt only at some changes).
    const found = deps.paths.laneOf(info.cwd);
    const lane = found && deps.store.get(found.id);
    return lane && lane.ownerId === info.ownerId && lane.state === "active" ? lane : null;
  };
  /** The checkpoint key of a leaf: `root` before the first entry; null (logged) for an id that is no entry id. */
  function keyOf(info: LaneRunInfo): { entryId: string } | "root" | null {
    if (info.leafId === null) return "root";
    if (EntryId.safeParse(info.leafId).success) return { entryId: info.leafId };
    deps.logger.warn("checkpoint_entry_id_invalid", { sessionId: info.sessionId });
    return null;
  }
  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.then(
      () => inflight.delete(work),
      () => inflight.delete(work),
    );
    return work;
  };

  /** Under the lock: the cap, the disk floor, the capture. Null when nothing was captured (and why is already told). */
  async function capture(
    lane: LaneRow,
    key: { entryId: string } | "root",
    released: { readonly value: boolean } | null,
    phase: "before" | "after",
    sessionId: string,
  ): Promise<void> {
    const gitDir = deps.gitDirOf(lane.worktree);
    if (gitDir === undefined) return;
    try {
      deps.diskFloor(lane.worktree);
    } catch {
      deps.notices.add(lane.id, "disk_low");
      return;
    }
    const refs = await kernel.refs(deps.git, lane.worktree, gitDir, lane.id);
    if (refs.size >= LANE_LIMITS.checkpointsPerLane) {
      if (!full.has(lane.id)) {
        full.add(lane.id);
        deps.logger.warn("checkpoints_full", { laneId: lane.id });
        deps.notices.add(lane.id, "checkpoints_full");
        deps.publish(lane.id);
      }
      return;
    }
    const ref = checkpointRef(lane.id, key);
    // The lane has one `root`, the files before its first session's first message; a later session at its start keeps it.
    if (key === "root" && refs.has(ref)) return;
    // Debug lines bracket each capture: under the lane lock they alternate, never overlap.
    deps.logger.debug("checkpoint_capture_start", { laneId: lane.id, phase, sessionId });
    const made = await kernel.capture(deps.git, lane.worktree, gitDir, deps.indexDir, ref);
    deps.logger.debug("checkpoint_capture_end", { laneId: lane.id, phase, sessionId });
    // The prompt went on while this capture ran: the files may have changed since, so `e/<leaf>` must not be replaced.
    if (released?.value === true) {
      deps.notices.add(lane.id, "checkpoint_before_late");
      return;
    }
    await deps.git.run(lane.worktree, ["update-ref", "--no-deref", ref, made.commit], { gitDir });
    if (made.skipped > 0) deps.notices.add(lane.id, "large_files_skipped", made.skipped);
  }

  const guarded = async (lane: LaneRow, work: () => Promise<void>): Promise<void> => {
    try {
      await deps.lock(lane.id).run("checkpoint", work);
    } catch (error) {
      deps.logger.warn("checkpoint_failed", { laneId: lane.id, err: error });
    }
  };

  function afterRun(info: LaneRunInfo): void {
    const lane = laneFor(info);
    if (!lane || deps.readOnly) return;
    const key = keyOf(info);
    void track(
      (async () => {
        if (key !== null) await guarded(lane, () => capture(lane, key, null, "after", info.sessionId));
        if (!ended.has(lane.id)) {
          ended.add(lane.id);
          deps.store.markFirstRunEnded(lane.id, deps.clock.now());
        }
        await deps.refreshFacts(lane.id);
        deps.publish(lane.id);
        for (const listener of listeners) {
          try {
            listener(lane, info);
          } catch (error) {
            deps.logger.warn("after_run_listener_failed", { err: error });
          }
        }
      })(),
    ).catch((error: unknown) => deps.logger.warn("after_run_failed", { err: error }));
  }

  return {
    beforePrompt(info, released) {
      const lane = laneFor(info);
      if (!lane || deps.readOnly) return undefined;
      const key = keyOf(info);
      if (key === null) return undefined;
      return track(
        guarded(lane, async () => {
          // Two prompts raced on one idle session, or a run began while this one waited for the lock: no capture.
          const state = deps.sessions()?.runState(info.ownerId, info.sessionId, { ownPrompt: true });
          if (!state?.idle || state.leafId !== info.leafId) return;
          if (laneFor(info) === null) return;
          await capture(lane, key, released, "before", info.sessionId);
        }),
      );
    },
    afterRun,
    full: (laneId) => full.has(laneId),
    onAfterRun: (listener) => void listeners.push(listener),
    forget(laneId) {
      full.delete(laneId);
      ended.delete(laneId);
    },
    async settled() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
