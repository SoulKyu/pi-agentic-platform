import { join } from "node:path";
import { denySourcesOf, type WorkspaceModules } from "./compose-workspace.ts";
import type { ProjectBoxSource } from "./kernel/boxes.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Db } from "./kernel/db/database.ts";
import { createPathDiskGuard } from "./kernel/disk.ts";
import type { Config } from "./kernel/config.ts";
import { type Forge, forgeFor, prepareForgeDir } from "./kernel/forge/port.ts";
import type { ForgeKind, HandlerTable, LaneMethodName } from "@pap/contracts";
import type { PlatformHandler } from "./modules/platform/index.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AuditModule } from "./modules/audit/index.ts";
import {
  createIssues,
  createLanesConfigModule,
  createLanesReview,
  createLanesScripts,
  createLanesService,
  createLanesSuggest,
  lanesArchiveRpc,
  lanesCheckpointsRpc,
  LANES_MIGRATIONS,
  type LanePaths,
  lanesCoreRpc,
  lanesFanoutRpc,
  lanesGitRpc,
  lanesIssueRpc,
  createLaneNote,
  createLanesStore,
} from "./modules/lanes/index.ts";
import type { RunsPort } from "./modules/runs/index.ts";
import type { PolicyPort } from "./modules/policy/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { TrustPort } from "./modules/trust/index.ts";
import {
  createWorktreesModule,
  WORKTREES_MIGRATIONS,
  type WorktreesPort,
} from "./modules/worktrees/index.ts";

/** The migration sources of the lanes side: `daemon.ts` spreads them into `MIGRATION_SOURCES`. */
export const LANE_MIGRATIONS = [WORKTREES_MIGRATIONS, LANES_MIGRATIONS] as const;

export type { LanePaths };

/** What the daemon hands lanes once the sessions module, Pi's trust and the stream hub exist (`daemon.ts`, one line). */
export interface LanesBindDeps {
  readonly sessions: Pick<SessionsModule, "lanes" | "setLaneHooks">;
  /**
   * Pi's side: archive clears a worktree's entry and a new lane inherits its project's decision through `status` and
   * `inherit` (M9R39, M9R83); the Pi modules learn the owner's lane folders through `useLaneRoots` (final review I1).
   */
  readonly pi: {
    readonly trust: Pick<TrustPort, "clear" | "status" | "inherit">;
    useLaneRoots(roots: (ownerId: string) => readonly string[]): void;
  };
  /** Whose session is tainted: a script is not run, nor a lane archived with one, without the owner saying so (M9R119). */
  readonly policy: Pick<PolicyPort, "sessionPolicy" | "markTainted">;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
}

export interface LanesCompose {
  readonly rpc: Pick<HandlerTable, LaneMethodName>;
  readonly paths: LanePaths;
  /** The platform op `lane.note` (M11R41): M11 registers it on the dispatcher. */
  readonly note: PlatformHandler<"lane.note">;
  /** Late-bound like `ownerOf`: sets the lane hooks on sessions and registers the `lane` stream. */
  bind(deps: LanesBindDeps): void;
  /** Undoes or finishes what a crash left; bounded to 60 s, so a stuck git never keeps the daemon from listening. */
  recover(): Promise<void>;
  /** Joins the closers: a script is stopped, and a create whose `worktree add` is running is waited for (MC3). */
  shutdown(): Promise<void>;
}

export interface LanesComposeDeps {
  readonly db: Db;
  /** The M8 workspace: its git runner, path boundary, deny set and `$PAP_HOME`, shared with the explorer (M8R28). */
  readonly wk: Pick<WorkspaceModules, "git" | "boundary" | "deny" | "home" | "runtime" | "runningIn"> &
    Partial<Pick<WorkspaceModules, "remoteProtocols">>;
  readonly audit: Pick<AuditModule, "port">;
  /** The caller's project roots, as stored. */
  roots(ownerId: string): readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  /** M10's floor (`PAP_MIN_FREE_DISK_MB`, `0` = off) for every lane path: `disk_low` below it (agreement 13). */
  readonly config: Pick<Config, "minFreeDiskMb">;
  /** Tests only: replaces the floor built from `config`. */
  readonly diskFloor?: (path: string) => undefined;
  /** The owner's box projects: a box root is "not a lane project", answered with no host read (boxes B1). */
  readonly boxes?: () => ProjectBoxSource | undefined;
  /** Members have no host lanes and run no lane script (M14). */
  readonly isMember: (userId: string) => boolean;
  /** M10's runs port: `sessionCost` is the compare column's cost (agreement 14). */
  readonly runs?: Pick<RunsPort, "sessionCost" | "sessionBilling">;
  /** Tests only: replaces the worktrees module. */
  readonly worktrees?: WorktreesPort;
}

export const RECOVERY_BUDGET_MS = 60_000;

export function composeLanes(deps: LanesComposeDeps): LanesCompose {
  const logger = deps.logger.child({ module: "lanes" });
  const diskFloor =
    deps.diskFloor ?? createPathDiskGuard({ floorMb: deps.config.minFreeDiskMb, logger: deps.logger });
  const { git, boundary, deny, home: papHome, runtime } = deps.wk;
  // The test seam only: a push to a local bare repository (`Config.testGitProtocols` names `file`).
  const allowFile = (deps.wk.remoteProtocols ?? "").split(":").includes("file");
  // The forge CLI runs from an empty folder whose real path bounds its git children (M9R46).
  const forgeDir = prepareForgeDir(papHome);
  const config = createLanesConfigModule({
    db: deps.db,
    git,
    clock: deps.clock,
    logger,
    boundary,
    deny,
    roots: deps.roots,
    audit: deps.audit.port,
    readOnly: deps.readOnly,
    allowFile,
    ...(deps.boxes ? { boxes: deps.boxes } : {}),
  });
  // The runner reports through the service, which is built after it (it needs the runner to run a setup).
  const bridge: { publish(laneId: string): void } = { publish: () => undefined };
  const scripts = createLanesScripts({
    onChange: (laneId) => bridge.publish(laneId),
    db: deps.db,
    clock: deps.clock,
    logger,
    home: papHome,
    approved: config.config.approvedScript,
    readOnly: deps.readOnly,
    ...runtime,
  });
  const worktrees =
    deps.worktrees ??
    createWorktreesModule({
      db: deps.db,
      git,
      clock: deps.clock,
      logger: deps.logger,
      papHome,
      readOnly: deps.readOnly,
      diskFloor,
    });
  const forge = (kind: ForgeKind): Forge | null =>
    forgeFor(kind, {
      env: runtime.env,
      forgeDir,
      logger: deps.logger.child({ module: "forge" }),
      clock: deps.clock,
    });
  const service = createLanesService({
    db: deps.db,
    git,
    clock: deps.clock,
    logger,
    home: papHome,
    worktrees,
    config: config.config,
    scripts: scripts.runner,
    terminals: { runningIn: deps.wk.runningIn },
    isMember: deps.isMember,
    boundary,
    deny,
    denyFolders: denySourcesOf(boundary).folders,
    readOnly: deps.readOnly,
    audit: deps.audit.port,
    allowFile,
    forgeFor: forge,
    diskFloor,
    ...(deps.runs
      ? {
          sessionCost: (sessionId: string) => deps.runs?.sessionCost(sessionId) ?? null,
          sessionBilling: (sessionId: string) => deps.runs?.sessionBilling(sessionId) ?? null,
        }
      : {}),
  });
  bridge.publish = service.publish;
  let sessionsPort: LanesBindDeps["sessions"]["lanes"] | undefined;
  const review = createLanesReview({
    db: deps.db,
    git,
    logger,
    gitDirOf: worktrees.gitDirOf,
    indexDir: join(papHome, "tmp", "git-index"),
    sessions: () => sessionsPort,
    readOnly: deps.readOnly,
    diskFloor,
  });
  const suggest = createLanesSuggest({
    db: deps.db,
    git,
    logger,
    gitDirOf: worktrees.gitDirOf,
    indexDir: join(papHome, "tmp", "git-index"),
    sessions: () => sessionsPort,
    readOnly: deps.readOnly,
    diskFloor,
  });
  return {
    rpc: {
      ...config.rpc,
      ...scripts.rpc,
      ...lanesCoreRpc(service),
      ...lanesArchiveRpc(service),
      ...lanesGitRpc(service),
      ...lanesCheckpointsRpc(service),
      ...lanesFanoutRpc(service),
      ...lanesIssueRpc(createIssues({ config: config.config, forgeFor: forge, logger })),
      ...review,
      ...suggest,
    },
    paths: service.paths,
    note: createLaneNote({
      store: createLanesStore(deps.db),
      sessions: { sessionIdsIn: (ownerId, folder) => sessionsPort?.sessionIdsIn(ownerId, folder) ?? [] },
      clock: deps.clock,
      publish: service.publish,
    }),
    bind({ sessions, hub, policy, pi }) {
      pi.useLaneRoots(service.paths.roots);
      sessionsPort = sessions.lanes;
      service.bind({ sessions: sessions.lanes, hub, policy, trust: pi.trust });
      // The hooks answer `undefined` synchronously when there is nothing to do: an `async () => {}` would yield and break the busy rule (M2R88).
      sessions.setLaneHooks({
        closed: (cwd) => service.paths.closed(cwd),
        holdsFiles: (cwd) => service.holdsFiles(cwd),
        assertOwn: (ownerId, cwd) => service.paths.assertOwnLane(ownerId, cwd),
        beforePrompt: service.checkpoints.beforePrompt,
        afterRun: service.checkpoints.afterRun,
      });
    },
    async recover() {
      let timer: ReturnType<Clock["setTimeout"]> | undefined;
      const budget = new Promise<"late">((resolve) => {
        timer = deps.clock.setTimeout(() => resolve("late"), RECOVERY_BUDGET_MS);
      });
      try {
        // Before the server listens: a script group a crash left behind dies first, and nothing is re-run (M9R116).
        await scripts.runner.recover().catch((error: unknown) => {
          logger.error("lane_script_recovery_failed", { err: error });
        });
        const outcome = await Promise.race([worktrees.recover().then(() => "done" as const), budget]);
        if (outcome === "late") logger.warn("worktree_recovery_timeout");
      } catch (error) {
        logger.error("worktree_recovery_failed", { err: error });
      } finally {
        if (timer) deps.clock.clearTimeout(timer);
      }
      try {
        await service.recover();
      } catch (error) {
        logger.error("lane_recovery_failed", { err: error });
      }
    },
    shutdown: async () => void (await Promise.all([scripts.runner.shutdown(), service.shutdown()])),
  };
}
