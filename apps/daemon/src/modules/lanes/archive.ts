import { type Caller, LANE_LIMITS, PapError, type Permission, type ResultOf } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { SessionsLanePort } from "../sessions/index.ts";
import type { TrustPort } from "../trust/index.ts";
import type { WorktreesPort } from "../worktrees/index.ts";
import { actorOf } from "./audit-rows.ts";
import type { LaneFacts } from "./facts.ts";
import type { LaneLock } from "./lane-lock.ts";
import type { LanePathsIndex } from "./paths.ts";
import type { LaneConfig } from "./preview.ts";
import type { ScriptRunner } from "./scripts.ts";
import type { LaneRow, LanesStore } from "./store.ts";

/** At most this many checkpoint refs are deleted for one lane (M9R40 step 7). */
export const MAX_CHECKPOINT_REFS = 2100;

export type ArchiveResult = ResultOf<"lanes.archive">;
export interface ArchiveParams {
  readonly laneId: string;
  readonly force: boolean;
  readonly deleteBranch: boolean;
  readonly confirmTainted?: boolean | undefined;
}

export interface ArchiveDeps {
  readonly store: LanesStore;
  readonly paths: Pick<LanePathsIndex, "rebuild">;
  readonly worktrees: Pick<WorktreesPort, "remove" | "deleteBranch" | "byPath">;
  readonly git: GitRunner;
  readonly scripts: Pick<ScriptRunner, "run" | "state" | "idle" | "logTail" | "deleteLogs">;
  readonly sessions: () => SessionsLanePort | undefined;
  readonly terminals: { runningIn(ownerId: string, folder: string): number };
  readonly trust: () => Pick<TrustPort, "clear"> | undefined;
  readonly approved: LaneConfig["approvedScript"];
  readonly facts: Pick<LaneFacts, "dirtyCount" | "forget">;
  readonly tainted: (lane: LaneRow) => boolean;
  readonly lock: (laneId: string) => LaneLock;
  /** A forced archive leaves a row: it destroys the owner's uncommitted work (final review M13). */
  readonly audit: Pick<AuditPort, "append">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  publish(laneId: string): void;
}

export interface Archiver {
  /** M9R40, in its order. Refusals are typed results; nothing changes before the lane turns `archiving`. */
  archive(caller: Caller, params: ArchiveParams): Promise<ArchiveResult>;
  /** Boot recovery: an `archiving` lane goes on from the worker release; the archive script is not run again (M9R41). */
  resume(lane: LaneRow): void;
  /** No new archive; the running ones are waited for. */
  stop(): Promise<void>;
  settled(): Promise<void>;
}

const refuse = (
  reason: Extract<ArchiveResult, { ok: false }>["reason"],
  logTail: string | null = null,
): ArchiveResult => ({
  ok: false,
  reason,
  logTail,
});
const running = (state: string): boolean => state === "queued" || state === "running";
const callerFor = (ownerId: string): Caller => ({
  userId: ownerId,
  permissions: new Set<Permission>(),
  kind: "session",
  credentialId: "",
  stepUpUntil: 0,
});

export function createArchiver(deps: ArchiveDeps): Archiver {
  const { store, logger } = deps;
  const inflight = new Set<Promise<unknown>>();
  let closing = false;

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.then(
      () => inflight.delete(work),
      () => inflight.delete(work),
    );
    return work;
  };
  const publishState = (laneId: string): void => {
    deps.paths.rebuild();
    deps.publish(laneId);
  };
  /** Back to `active`: the lane is exactly as the person left it (the script, if it ran, is the one thing that happened). */
  function revert(laneId: string): void {
    store.setState(laneId, "active");
    publishState(laneId);
  }

  function busyNow(lane: LaneRow): boolean {
    const sessions = deps.sessions();
    if (!sessions) throw new PapError("capacity");
    return (
      sessions.activityIn(lane.ownerId, lane.worktree).busy ||
      deps.terminals.runningIn(lane.ownerId, lane.worktree) > 0
    );
  }

  /** Step 1: every refusal, before anything changes. */
  async function refusal(lane: LaneRow, params: ArchiveParams): Promise<ArchiveResult | null> {
    if (busyNow(lane)) return refuse("busy");
    if (
      running(deps.scripts.state(lane.id, "test").state) ||
      running(deps.scripts.state(lane.id, "archive").state)
    )
      return refuse("busy");
    if (running(deps.scripts.state(lane.id, "setup").state)) return refuse("setup_running");
    if (!params.force) {
      // Git cannot say: not clean enough to delete without the person's force.
      const dirty = await deps.facts.dirtyCount(lane).catch(() => 1);
      if (dirty > 0) return refuse("dirty");
    }
    if (params.confirmTainted !== true) {
      const archive = await deps.approved(lane.ownerId, lane.projectRoot, "archive").catch(() => null);
      if (archive?.ok === true && deps.tainted(lane)) return refuse("tainted");
    }
    return null;
  }

  /** Step 3: the approved archive script. Null: go on. */
  async function runScript(lane: LaneRow, params: ArchiveParams): Promise<ArchiveResult | null> {
    const ref = {
      id: lane.id,
      ownerId: lane.ownerId,
      projectRoot: lane.projectRoot,
      worktree: lane.worktree,
    };
    const started = await deps.scripts.run(ref, "archive");
    if (!started.ok) return started.reason === "running" ? refuse("busy") : null;
    await deps.scripts.idle(lane.id);
    if (deps.scripts.state(lane.id, "archive").state === "ok" || params.force) return null;
    return refuse("script_failed", deps.scripts.logTail(lane.id, "archive", LANE_LIMITS.logTail));
  }

  /** Step 7: every checkpoint ref of the lane. A ref that stays is dangling, never harmful: it is logged. */
  async function dropCheckpointRefs(repoRoot: string, laneId: string): Promise<void> {
    try {
      const { stdout } = await deps.git.run(repoRoot, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/pap/checkpoints/${laneId}`,
      ]);
      const refs = stdout.toString("utf8").split("\n").filter(Boolean).slice(0, MAX_CHECKPOINT_REFS);
      for (const ref of refs) await deps.git.run(repoRoot, ["update-ref", "-d", "--no-deref", ref]);
    } catch (error) {
      logger.warn("lane_checkpoint_refs_not_deleted", { laneId, err: error });
    }
  }

  /** Steps 4 to 12, under the lane lock. */
  async function finish(
    lane: LaneRow,
    params: ArchiveParams,
    caller: Caller,
    recheck: boolean,
  ): Promise<ArchiveResult> {
    const sessions = deps.sessions();
    if (!sessions) throw new PapError("capacity");
    // A run that started between the first look and the lock: the lane goes back, whatever the script did.
    if (recheck && busyNow(lane)) {
      revert(lane.id);
      return refuse("busy");
    }
    // The worktree row is gone once removed, and the branch is deleted from its repository.
    const repoRoot = deps.worktrees.byPath(lane.worktree)?.repoRoot ?? lane.projectRoot;
    // A worker `releaseIdle` leaves alone (a dialog, a panel, a queue, a command in flight) would lose its folder: nothing is removed.
    if (sessions.releaseIn(lane.ownerId, lane.worktree).busy > 0) {
      revert(lane.id);
      return refuse("busy");
    }
    // Before the folder goes (final review I2): Pi's helper resolves the folder's real path, so a clear after the removal
    // never found it and the entry stayed. Always, whoever wrote the entry; best effort. The dirty refusal came earlier.
    await deps
      .trust()
      ?.clear(lane.ownerId, lane.worktree)
      .catch((error: unknown) => {
        logger.warn("lane_archive_trust_not_cleared", { laneId: lane.id, err: error });
      });
    let removed: Awaited<ReturnType<ArchiveDeps["worktrees"]["remove"]>>;
    try {
      removed = await deps.worktrees.remove({ path: lane.worktree, force: params.force });
    } catch (error) {
      logger.error("lane_archive_remove_failed", { laneId: lane.id, err: error });
      revert(lane.id);
      throw new PapError("capacity");
    }
    if (!removed.ok) {
      revert(lane.id);
      return refuse("dirty");
    }
    await dropCheckpointRefs(repoRoot, lane.id);
    const branchDeleted = params.deleteBranch
      ? await deps.worktrees.deleteBranch({ repoRoot, branch: lane.branch })
      : null;
    sessions.archiveIn(caller, lane.worktree);
    try {
      deps.scripts.deleteLogs(lane.id);
    } catch (error) {
      logger.warn("lane_archive_logs_not_deleted", { laneId: lane.id, err: error });
    }
    store.setState(lane.id, "archived", { at: deps.clock.now() });
    deps.facts.forget(lane.id);
    publishState(lane.id);
    if (params.force)
      deps.audit.append({
        ownerId: lane.ownerId,
        ...actorOf(caller),
        kind: "policy",
        reason: "lane_archived_forced",
        detail: { laneId: lane.id, deleteBranch: params.deleteBranch, branchDeleted },
      });
    return { ok: true, branchDeleted };
  }

  async function archive(caller: Caller, params: ArchiveParams): Promise<ArchiveResult> {
    const lane = store.getOwned(caller.userId, params.laneId);
    if (!lane) throw new PapError("not_found");
    if (deps.readOnly) throw new PapError("read_only");
    if (closing) throw new PapError("capacity");
    if (lane.state === "archived") return { ok: true, branchDeleted: null };
    if (lane.state === "failed") {
      // A failed lane has no worktree: it only leaves the open list. `branchDeleted` stays null even when asked: its
      // worktree row (and with it whether pap created the branch) is gone, and the creation undo already removed a
      // branch pap made, so a delete here could only hit a branch the owner had before.
      try {
        deps.scripts.deleteLogs(lane.id);
      } catch (error) {
        logger.warn("lane_archive_logs_not_deleted", { laneId: lane.id, err: error });
      }
      store.setState(lane.id, "archived", { at: deps.clock.now() });
      deps.facts.forget(lane.id);
      publishState(lane.id);
      return { ok: true, branchDeleted: null };
    }
    if (lane.state !== "active") return refuse("busy");
    const refused = await refusal(lane, params);
    if (refused) return refused;
    // Nothing awaits from here to the state write, so two archives cannot both pass.
    if (store.get(lane.id)?.state !== "active") return refuse("busy");
    store.setState(lane.id, "archiving");
    publishState(lane.id);
    try {
      const stored = store.get(lane.id) as LaneRow;
      const stopped = await runScript(stored, params);
      if (stopped) {
        revert(lane.id);
        return stopped;
      }
    } catch (error) {
      revert(lane.id);
      throw error;
    }
    return deps
      .lock(lane.id)
      .run("archive", () => finish(store.get(lane.id) as LaneRow, params, caller, true));
  }

  return {
    archive: (caller, params) => track(archive(caller, params)),
    resume(lane) {
      const params = { laneId: lane.id, force: false, deleteBranch: false };
      const work = deps
        .lock(lane.id)
        .run("archive", () => finish(lane, params, callerFor(lane.ownerId), false))
        .then((result) => {
          if (!result.ok) logger.warn("lane_archive_not_resumed", { laneId: lane.id, reason: result.reason });
        })
        .catch((error: unknown) =>
          logger.error("lane_archive_resume_failed", { laneId: lane.id, err: error }),
        );
      void track(work);
    },
    async stop() {
      closing = true;
      await Promise.allSettled([...inflight]);
    },
    settled: async () => void (await Promise.allSettled([...inflight])),
  };
}
