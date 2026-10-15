import { type Caller, LANE_LIMITS, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import { checkpointRef, entryIdsOf } from "../../kernel/git/checkpoint.ts";
import { GitError } from "../../kernel/git/runner.ts";
import type { LeftEntry } from "../../kernel/git/snapshot.ts";
import { checkpointTarget } from "../../kernel/git/turn-range.ts";
import { type CheckpointBase, REAL_KERNEL } from "./checkpoints.ts";
import { guardSnapshot } from "./disk-floor.ts";
import type { ScriptRunner } from "./scripts.ts";
import type { LaneRow, LanesStore } from "./store.ts";

type RestoreResult = ResultOf<"lanes.restore">;
type Status = ResultOf<"lanes.checkpointStatus">;

/** How long the snapshot of a lane's files is reused by `checkpointStatus` (M9R74). */
export const SNAPSHOT_MEMO_MS = 2000;
const SCRIPT_KINDS = ["setup", "test", "archive"] as const;
const refuse = (reason: "busy" | "no_checkpoint" | "failed"): RestoreResult => ({ ok: false, reason });

export interface RestoreDeps extends CheckpointBase {
  readonly store: Pick<LanesStore, "getOwned">;
  readonly scripts: Pick<ScriptRunner, "state">;
}

export interface Restorer {
  restore(caller: Caller, params: ParamsOf<"lanes.restore">): Promise<RestoreResult>;
  checkpointStatus(caller: Caller, params: ParamsOf<"lanes.checkpointStatus">): Promise<Status>;
}

/** The first few entries a restore left, as text for the owner, and the total. */
function leftOf(entries: readonly LeftEntry[]) {
  return {
    left: entries.slice(0, LANE_LIMITS.restoreLeft).map((entry) => ({
      path: entry.path.toString("utf8").slice(0, LANE_LIMITS.restoreLeftPath),
      reason: entry.reason,
    })),
    leftTotal: entries.length,
  };
}

export function createRestorer(deps: RestoreDeps): Restorer {
  const kernel = deps.kernel ?? REAL_KERNEL;
  const memo = new Map<string, { at: number; tree: string }>();

  const port = () => {
    const sessions = deps.sessions();
    if (!sessions) throw new PapError("capacity");
    return sessions;
  };
  function owned(caller: Caller, laneId: string): LaneRow {
    const lane = deps.store.getOwned(caller.userId, laneId);
    if (!lane) throw new PapError("not_found");
    return lane;
  }
  /** The session must be the caller's and live in this lane's folder. */
  function ownSession(lane: LaneRow, sessionId: string): void {
    if (!port().sessionIdsIn(lane.ownerId, lane.worktree).includes(sessionId))
      throw new PapError("not_found");
  }
  const busy = (lane: LaneRow): boolean =>
    port().activityIn(lane.ownerId, lane.worktree).busy ||
    SCRIPT_KINDS.some((kind) => {
      const state = deps.scripts.state(lane.id, kind).state;
      return state === "queued" || state === "running";
    });
  const treeOf = async (lane: LaneRow, gitDir: string, commit: string): Promise<string> =>
    (await deps.git.run(lane.worktree, ["rev-parse", "--verify", `${commit}^{tree}`], { gitDir })).stdout
      .toString("utf8")
      .trim();

  /** The checkpoint a session's branch restores to: the nearest one at or before its leaf. */
  async function branchTarget(
    caller: Caller,
    lane: LaneRow,
    sessionId: string,
    refs: ReadonlyMap<string, string>,
  ) {
    const path = await port().branchPath(caller, sessionId);
    const found = checkpointTarget(path.entries, entryIdsOf(refs, lane.id));
    if (found === null) return null;
    const commit = refs.get(
      checkpointRef(lane.id, found.entryId === null ? "root" : { entryId: found.entryId }),
    );
    return commit === undefined ? null : { found, commit };
  }

  const gitFailure = (error: unknown): never => {
    if (error instanceof PapError) throw error;
    if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
    throw new PapError("capacity");
  };

  async function checkpointStatus(
    caller: Caller,
    params: ParamsOf<"lanes.checkpointStatus">,
  ): Promise<Status> {
    const lane = owned(caller, params.laneId);
    ownSession(lane, params.sessionId);
    const gitDir = deps.gitDirOf(lane.worktree);
    if (lane.state !== "active" || gitDir === undefined)
      return { target: null, exact: false, differs: false, undoAvailable: false };
    try {
      const refs = await kernel.refs(deps.git, lane.worktree, gitDir, lane.id);
      const undoAvailable = refs.has(checkpointRef(lane.id, "undo"));
      const target = await branchTarget(caller, lane, params.sessionId, refs);
      if (target === null) return { target: null, exact: false, differs: false, undoAvailable };
      let current = memo.get(lane.id);
      if (!current || deps.clock.now() - current.at >= SNAPSHOT_MEMO_MS) {
        guardSnapshot(deps, lane.worktree);
        const snapshot = await kernel.snapshot(deps.git, lane.worktree, gitDir, deps.indexDir);
        current = { at: deps.clock.now(), tree: snapshot.tree };
        memo.set(lane.id, current);
      }
      return {
        target: { entryId: target.found.entryId, turn: target.found.turn },
        exact: target.found.exact,
        differs: (await treeOf(lane, gitDir, target.commit)) !== current.tree,
        undoAvailable,
      };
    } catch (error) {
      return gitFailure(error);
    }
  }

  /** Under the lane lock and with no one running: undo capture, restore, facts (M9R75). */
  async function restoreLocked(
    caller: Caller,
    lane: LaneRow,
    gitDir: string,
    params: ParamsOf<"lanes.restore">,
  ): Promise<RestoreResult> {
    if (busy(lane)) return refuse("busy");
    const refs = await kernel.refs(deps.git, lane.worktree, gitDir, lane.id);
    const undoRef = checkpointRef(lane.id, "undo");
    const commit =
      "undo" in params
        ? refs.get(undoRef)
        : "sessionId" in params
          ? (await branchTarget(caller, lane, params.sessionId, refs))?.commit
          : undefined;
    if (commit === undefined) return refuse("no_checkpoint");
    try {
      deps.diskFloor(lane.worktree);
    } catch (error) {
      throw error instanceof PapError ? error : new PapError("capacity");
    }
    // The lane as it is now: the base the restore diffs against, and what `undo` will hold.
    const current = await kernel.capture(deps.git, lane.worktree, gitDir, deps.indexDir, undoRef);
    // Same files as the target: nothing to do, and `undo` keeps the owner's earlier work (M9-RT-06).
    if (current.tree === (await treeOf(lane, gitDir, commit))) return { ok: true, changed: false };
    // Undo is a swap: the lane as it is now goes to `undo` before anything is applied, so nothing is ever left
    // unreferenced (an ignored file, a hand edit made since the restore) and Undo of Undo returns to this state.
    await deps.git.run(lane.worktree, ["update-ref", "--no-deref", undoRef, current.commit], { gitDir });
    try {
      const done = await kernel.restore(deps.git, lane.worktree, gitDir, commit, current);
      return { ok: true, changed: true, ...leftOf(done.left) };
    } finally {
      memo.delete(lane.id);
      await deps.refreshFacts(lane.id);
      deps.publish(lane.id);
    }
  }

  async function restore(caller: Caller, params: ParamsOf<"lanes.restore">): Promise<RestoreResult> {
    const lane = owned(caller, params.laneId);
    if ("sessionId" in params) ownSession(lane, params.sessionId);
    const gitDir = deps.gitDirOf(lane.worktree);
    if (deps.readOnly || lane.state !== "active" || gitDir === undefined) return refuse("failed");
    if (busy(lane)) return refuse("busy");
    try {
      return await deps.lock(lane.id).run("restore", () => restoreLocked(caller, lane, gitDir, params));
    } catch (error) {
      if (error instanceof PapError) throw error;
      if (error instanceof GitError && error.kind === "timeout") throw new PapError("timeout");
      deps.logger.warn("lane_restore_failed", { laneId: lane.id, err: error });
      return refuse("failed");
    }
  }

  return { restore, checkpointStatus };
}
