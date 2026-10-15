import { join } from "node:path";
import {
  type Caller,
  type ForgeKind,
  LANE_LIMITS,
  type LaneStreamEvent,
  type LaneView,
  PapError,
  type ParamsOf,
  type ResultOf,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Forge } from "../../kernel/forge/port.ts";
import type { BoundaryConfig } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { SessionsLanePort } from "../sessions/index.ts";
import type { TrustPort } from "../trust/index.ts";
import type { WorktreesPort } from "../worktrees/index.ts";
import { type ArchiveParams, createArchiver } from "./archive.ts";
import { autoTestListener } from "./auto-test.ts";
import { applyCopyLink } from "./copy-link.ts";
import { type Checkpoints, createCheckpoints } from "./checkpoints.ts";
import { createCloseLosers } from "./close-losers.ts";
import { createCompare } from "./compare.ts";
import { createLaneCreator, openSession } from "./create.ts";
import { localDiskFloor } from "./disk-floor.ts";
import { createLaneNotices, type LaneNotices } from "./notices.ts";
import { createLaneLocks, type LaneLock } from "./lane-lock.ts";
import { createLanePaths, type LanePathsIndex } from "./paths.ts";
import type { LaneConfig } from "./preview.ts";
import { recoverLanes } from "./recover.ts";
import { createRestorer } from "./restore.ts";
import { createRunScript, taintedIn } from "./run-script.ts";
import type { ScriptRunner } from "./scripts.ts";
import { createGitServices } from "./service-git.ts";
import { createLanesStore, type LaneRow } from "./store.ts";
import { createLaneStream, type LaneHub } from "./stream.ts";
import { viewOf } from "./view.ts";

export interface LanesServiceDeps {
  readonly db: Db;
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `$PAP_HOME`. */
  readonly home: string;
  readonly worktrees: WorktreesPort;
  readonly config: Pick<LaneConfig, "preview" | "approvedScript"> & Partial<Pick<LaneConfig, "forgeLine">>;
  readonly scripts: Pick<ScriptRunner, "run" | "state" | "idle" | "logTail" | "deleteLogs">;
  /** The owner's running terminals in a folder or below: a lane is not archived under a shell. */
  readonly terminals: { runningIn(ownerId: string, folder: string): number };
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  readonly denyFolders: readonly string[];
  readonly readOnly: boolean;
  /** Throws when the filesystem of the path is too full (M9R117); M10 replaces the default with its own. */
  readonly diskFloor?: (path: string) => undefined;
  /** The audit row of a push (an external write by the owner). */
  readonly audit?: Pick<AuditPort, "append">;
  /** `Config.testGitProtocols` includes `file`: the push test seam (default false). */
  readonly allowFile?: boolean;
  /** The forge adapter of a kind, or null when pap has none (default: none). */
  readonly forgeFor?: (kind: ForgeKind) => Forge | null;
  /** M10's `RunsPort.sessionCost`: the compare column's cost (null without it, M9R85). */
  readonly sessionCost?: (sessionId: string) => number | null;
  readonly copyLink?: typeof applyCopyLink;
  readonly random?: (bytes: number) => Buffer;
  readonly schedule?: (flush: () => void) => void;
}

export interface LanesBinding {
  readonly sessions: SessionsLanePort;
  /** Who may be asked of a session's taint (M9R119) and whose trust entry goes with an archived worktree (M9R40). */
  readonly policy: Pick<PolicyPort, "sessionPolicy" | "markTainted">;
  readonly trust: Pick<TrustPort, "clear" | "status" | "inherit">;
  readonly hub: LaneHub;
}

export interface LanesService {
  readonly paths: LanePathsIndex;
  readonly notices: LaneNotices;
  create(caller: Caller, params: ParamsOf<"lanes.create">): Promise<ResultOf<"lanes.create">>;
  newSession(caller: Caller, laneId: string): Promise<{ sessionId: string }>;
  /** The caller's own lane; another owner's is `not_found`. */
  get(caller: Caller, laneId: string): LaneView;
  snapshot(ownerId: string): Extract<LaneStreamEvent, { kind: "snapshot" }>;
  listArchived(caller: Caller, params: ParamsOf<"lanes.listArchived">): ResultOf<"lanes.listArchived">;
  /** After every state change of a lane: coalesced per tick onto the lane stream, and wakes a create waiting for setup. */
  publish(laneId: string): void;
  /** Late-bound, once the sessions module and the hub exist. */
  bind(binding: LanesBinding): void;
  /** After the worktrees module recovered: a lane a crash left `creating` becomes `active` or `failed`; an `archiving` one is finished. */
  recover(): Promise<void>;
  /** `lanes.archive` (M9R40); closeLosers (Task 18b) archives each loser through it. */
  archive(caller: Caller, params: ArchiveParams): Promise<ResultOf<"lanes.archive">>;
  /** `lanes.runScript` (M9R119), browser only. */
  runScript(caller: Caller, params: ParamsOf<"lanes.runScript">): Promise<ResultOf<"lanes.runScript">>;
  /** `lanes.refresh`: the lane's facts are read again; answers when they are. */
  refresh(caller: Caller, laneId: string): Promise<{ ok: true }>;
  /** Refreshes the facts of a lane (after a commit, a push, a restore or a run's end); never throws. */
  refreshFacts(laneId: string): Promise<void>;
  /** `lanes.commit` (M9R68), under the lane lock. */
  commit(caller: Caller, params: ParamsOf<"lanes.commit">): Promise<ResultOf<"lanes.commit">>;
  /** `lanes.push` (M9R69), under the lane's push mutex. */
  push(caller: Caller, params: ParamsOf<"lanes.push">): Promise<ResultOf<"lanes.push">>;
  prCreate(caller: Caller, params: ParamsOf<"lanes.prCreate">): Promise<ResultOf<"lanes.prCreate">>;
  prRefresh(caller: Caller, params: ParamsOf<"lanes.prRefresh">): Promise<ResultOf<"lanes.prRefresh">>;
  /** The lane lock every file-changing operation shares (M9R120). */
  laneLock(laneId: string): LaneLock;
  /** `lanes.compare` (M9R85): one column per lane of a fan-out group, facts only. */
  compare(caller: Caller, params: ParamsOf<"lanes.compare">): Promise<ResultOf<"lanes.compare">>;
  /** `lanes.closeLosers` (M9R86): archives every other lane of the group through `archive`. */
  closeLosers(caller: Caller, params: ParamsOf<"lanes.closeLosers">): Promise<ResultOf<"lanes.closeLosers">>;
  /** The hooks around a prompt and a run's end, and the listeners of a run's end (Task 15; Task 18b joins). */
  readonly checkpoints: Pick<Checkpoints, "beforePrompt" | "afterRun" | "onAfterRun">;
  /** `lanes.checkpointStatus` (M9R74). */
  checkpointStatus(
    caller: Caller,
    params: ParamsOf<"lanes.checkpointStatus">,
  ): Promise<ResultOf<"lanes.checkpointStatus">>;
  /** `lanes.restore` (M9R75), under the lane lock. */
  restore(caller: Caller, params: ParamsOf<"lanes.restore">): Promise<ResultOf<"lanes.restore">>;
  /** A restore holds the lane's files: the promise of its end, else null. */
  holdsFiles(cwd: string): Promise<void> | null;
  /** Whether a session of the lane is tainted (M9R119). */
  taintedIn(lane: Pick<LaneRow, "ownerId" | "worktree">): boolean;
  settled(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createLanesService(deps: LanesServiceDeps): LanesService {
  const { logger } = deps;
  const store = createLanesStore(deps.db);
  const paths = createLanePaths(store);
  paths.rebuild();
  let sessions: SessionsLanePort | undefined;
  let policy: Pick<PolicyPort, "sessionPolicy" | "markTainted"> | undefined;
  let trust: Pick<TrustPort, "clear" | "status" | "inherit"> | undefined;
  const waiters = new Map<string, Array<() => void>>();
  let stopping = false;
  // `recover` runs before the sessions and policy ports exist (daemon order): an archive resumes once they are bound.
  let bound = false;
  const toResume: LaneRow[] = [];

  const auditPort = deps.audit ?? { append: () => undefined };
  const notices = createLaneNotices(deps.clock, (laneId) => publish(laneId));
  const locks = createLaneLocks((cwd) => paths.laneOf(cwd)?.id ?? null);
  const allowFile = deps.allowFile ?? false;
  const { facts, remote, prs, outward, refreshFacts, committer, pusher } = createGitServices({
    ...deps,
    notices,
    lock: locks.laneLock,
    audit: auditPort,
    allowFile,
    forgeFor: deps.forgeFor,
    store,
    publish,
  });
  const tainted = taintedIn(
    () => sessions,
    () => policy,
  );
  const checkpointBase = {
    git: deps.git,
    // The runner accepts a temporary index only here (`compose-workspace.ts`).
    indexDir: join(deps.home, "tmp", "git-index"),
    gitDirOf: deps.worktrees.gitDirOf,
    lock: locks.laneLock,
    notices,
    diskFloor: deps.diskFloor ?? localDiskFloor,
    sessions: () => sessions,
    refreshFacts,
    publish: (laneId: string) => publish(laneId),
    clock: deps.clock,
    logger,
    readOnly: deps.readOnly,
  };
  const checkpoints = createCheckpoints({ ...checkpointBase, store, paths });
  const restorer = createRestorer({ ...checkpointBase, store, scripts: deps.scripts });
  const stream = createLaneStream({
    store,
    notices,
    checkpointsFull: checkpoints.full,
    logger,
    facts: facts.view,
    outward,
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
  });
  const setupRunning = (laneId: string): boolean => {
    const state = store.get(laneId)?.setupState;
    return state === "queued" || state === "running";
  };
  function publish(laneId: string): void {
    stream.changed(laneId);
    if (setupRunning(laneId)) return;
    const waiting = waiters.get(laneId);
    waiters.delete(laneId);
    for (const wake of waiting ?? []) wake();
  }

  const creator = createLaneCreator({
    store,
    git: deps.git,
    clock: deps.clock,
    logger,
    home: deps.home,
    worktrees: deps.worktrees,
    config: deps.config,
    scripts: deps.scripts,
    paths,
    notices,
    boundary: deps.boundary,
    deny: deps.deny,
    denyFolders: deps.denyFolders,
    readOnly: deps.readOnly,
    diskFloor: deps.diskFloor ?? localDiskFloor,
    copyLink: deps.copyLink ?? applyCopyLink,
    publish,
    publishFanout: stream.fanoutChanged,
    awaitSetup: (laneId) =>
      new Promise<void>((resolve) => {
        if (!setupRunning(laneId)) return resolve();
        waiters.set(laneId, [...(waiters.get(laneId) ?? []), resolve]);
      }),
    sessions: () => sessions,
    ports: () => policy && trust && { policy, trust, audit: deps.audit },
    ...(deps.random ? { random: deps.random } : {}),
  });

  const archiver = createArchiver({
    store,
    paths,
    worktrees: deps.worktrees,
    git: deps.git,
    scripts: deps.scripts,
    sessions: () => sessions,
    terminals: deps.terminals,
    trust: () => trust,
    approved: deps.config.approvedScript,
    facts: {
      dirtyCount: facts.dirtyCount,
      forget(laneId) {
        facts.forget(laneId);
        remote.forget(laneId);
        prs.forget(laneId);
        checkpoints.forget(laneId);
      },
    },
    tainted,
    lock: locks.laneLock,
    audit: auditPort,
    clock: deps.clock,
    logger,
    readOnly: deps.readOnly,
    publish,
  });
  const runScript = createRunScript({
    store,
    scripts: deps.scripts,
    tainted,
    readOnly: deps.readOnly,
    publish,
  });

  checkpoints.onAfterRun(
    autoTestListener({
      store,
      notices,
      scripts: deps.scripts,
      tainted,
      logger,
      readOnly: deps.readOnly,
      publish,
    }),
  );
  const compare = createCompare({
    git: deps.git,
    logger,
    store,
    gitDirOf: deps.worktrees.gitDirOf,
    indexDir: checkpointBase.indexDir,
    diskFloor: checkpointBase.diskFloor,
    readOnly: deps.readOnly,
    sessions: () => sessions,
    ...(deps.sessionCost ? { sessionCost: deps.sessionCost } : {}),
  });
  const closeLosers = createCloseLosers({
    store,
    archive: archiver.archive,
    audit: auditPort,
    readOnly: deps.readOnly,
  });

  const owned = (caller: Caller, laneId: string) => {
    const row = store.getOwned(caller.userId, laneId);
    if (!row) throw new PapError("not_found");
    return row;
  };

  return {
    paths,
    notices,
    create: creator.create,
    async newSession(caller, laneId) {
      const row = owned(caller, laneId);
      if (deps.readOnly) throw new PapError("read_only");
      if (row.state !== "active") throw new PapError("conflict");
      const sessionId = await openSession({ store, notices, sessions: () => sessions }, row, caller);
      publish(laneId);
      return { sessionId };
    },
    get(caller, laneId) {
      const row = owned(caller, laneId);
      return viewOf(row, notices.list(laneId), null, outward(row), checkpoints.full(laneId));
    },
    snapshot: stream.snapshot,
    listArchived(caller, params) {
      const limit = LANE_LIMITS.archivedPage;
      const rows = store.archivedPage(caller.userId, params.before ?? null, limit + 1);
      const lanes: LaneView[] = [];
      let used = sizeOf({ lanes: [], hasMore: true });
      for (const row of rows.slice(0, limit)) {
        const view = viewOf(row, notices.list(row.id), null, outward(row), checkpoints.full(row.id));
        const size = sizeOf(view) + 1;
        if (used + size > PAGE_BYTES) return { lanes, hasMore: true };
        used += size;
        lanes.push(view);
      }
      return { lanes, hasMore: rows.length > limit };
    },
    publish,
    archive: archiver.archive,
    runScript,
    async refresh(caller, laneId) {
      owned(caller, laneId);
      if (stopping) throw new PapError("capacity");
      await Promise.all([facts.refresh(laneId), remote.refresh(laneId)]);
      return { ok: true };
    },
    refreshFacts,
    commit: committer.commit,
    push: pusher.push,
    prCreate: prs.prCreate,
    prRefresh: prs.prRefresh,
    compare,
    closeLosers,
    checkpoints,
    checkpointStatus: restorer.checkpointStatus,
    restore: restorer.restore,
    laneLock: locks.laneLock,
    holdsFiles: locks.holdsFiles,
    taintedIn: tainted,
    bind(binding) {
      sessions = binding.sessions;
      policy = binding.policy;
      trust = binding.trust;
      bound = true;
      for (const lane of toResume.splice(0)) archiver.resume(lane);
      stream.bind(binding.hub);
    },
    recover: () =>
      recoverLanes({
        store,
        worktrees: deps.worktrees,
        approved: deps.config.approvedScript,
        paths,
        logger,
        readOnly: deps.readOnly,
        resume: (lane) => (bound ? archiver.resume(lane) : void toResume.push(lane)),
      }),
    settled: async () => {
      await Promise.all([creator.settled(), archiver.settled(), facts.settled(), remote.settled()]);
    },
    async shutdown() {
      // A create waiting for a setup that is being stopped wakes up and ends; nothing new starts.
      stopping = true;
      const ending = Promise.all([creator.stop(), archiver.stop()]);
      for (const wake of [...waiters.values()].flat()) wake();
      waiters.clear();
      await ending;
      await Promise.all([facts.settled(), remote.settled()]);
    },
  };
}
