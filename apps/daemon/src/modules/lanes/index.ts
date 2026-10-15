import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerScopes } from "../../kernel/supervisor/scope.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import { createLaneReview, type LaneReviewDeps } from "./review.ts";
import { createReviewStore } from "./review-store.ts";
import { createLanesStore } from "./store.ts";
import { type LanesReviewRpc, lanesReviewRpc } from "./rpc-review.ts";
import { type LanesSuggestRpc, lanesSuggestRpc } from "./rpc-suggest.ts";
import { createLaneSuggest, type LaneSuggestDeps } from "./suggest.ts";
import { createLaneConfig, type LaneConfig, type LaneConfigDeps } from "./preview.ts";
import { type LanesConfigRpc, lanesConfigRpc } from "./rpc-config.ts";
import { type LanesScriptsRpc, lanesScriptsRpc } from "./rpc-scripts.ts";
import { LINUX_PROBE } from "./script-orphans.ts";
import { spawnScript } from "./script-spawn.ts";
import { createScriptStore } from "./script-store.ts";
import { createScriptRunner, type ScriptRunner, type ScriptRunnerDeps } from "./scripts.ts";

export { type CheckpointDeps, type CheckpointKernel, createCheckpoints } from "./checkpoints.ts";
export { createLaneLocks } from "./lane-lock.ts";
export { createLaneNotices } from "./notices.ts";
export { createRestorer, type RestoreDeps } from "./restore.ts";
export type { LaneRow } from "./store.ts";
export { createLaneConfig } from "./preview.ts";
export { scriptHash } from "./project-config.ts";
export type { LanePaths } from "./paths.ts";
export { lanesArchiveRpc } from "./rpc-archive.ts";
export { lanesCheckpointsRpc } from "./rpc-checkpoints.ts";
export { lanesCoreRpc } from "./rpc-core.ts";
export { lanesGitRpc } from "./rpc-git.ts";
export { createIssues } from "./issue.ts";
export { lanesFanoutRpc } from "./rpc-fanout.ts";
export { lanesIssueRpc } from "./rpc-issue.ts";
export { createLanesService, type LanesService, type LanesServiceDeps } from "./service.ts";
// The seams the module's own test helpers (`testing/`, which may only import this file) build runners from.
export type { ProcProbe } from "./script-orphans.ts";
export type { ScriptChild, ScriptExit, ScriptSpec } from "./script-spawn.ts";
export { createScriptStore, type LaneRef } from "./script-store.ts";
export { createScriptRunner, type GroupOps, type ScriptRunnerDeps } from "./scripts.ts";

export const LANES_MIGRATIONS: MigrationSource = {
  module: "lanes",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface LanesConfigModule {
  readonly rpc: LanesConfigRpc;
  readonly config: LaneConfig;
}

/** `.pi/project.yaml` of a project: the preview of its refs and settings, and the approval of its scripts. */
export function createLanesConfigModule(deps: LaneConfigDeps): LanesConfigModule {
  const config = createLaneConfig(deps);
  return { rpc: lanesConfigRpc(config), config };
}

export interface LanesScriptsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly umask: number;
  readonly scopes: Pick<WorkerScopes, "next">;
  readonly approved: ScriptRunnerDeps["approved"];
  readonly readOnly: boolean;
  /** Task 6b's lane stream. */
  readonly onChange?: (laneId: string) => void;
}

export interface LanesScripts {
  readonly runner: ScriptRunner;
  readonly rpc: LanesScriptsRpc;
}

/** The runner of setup, archive and test scripts, and `lanes.scriptLog`. */
export function createLanesScripts(deps: LanesScriptsDeps): LanesScripts {
  const runner = createScriptRunner({
    ...deps,
    store: createScriptStore(deps.db),
    spawn: spawnScript(deps.clock),
    probe: LINUX_PROBE,
  });
  return { runner, rpc: lanesScriptsRpc(runner) };
}

export type LanesReviewDeps = Omit<LaneReviewDeps, "lanes" | "reviews"> & { readonly db: Db };

/** `lanes.review`, `lanes.turns` and the Seen files and comments of a lane (Task 16). */
export function createLanesReview(deps: LanesReviewDeps): LanesReviewRpc {
  return lanesReviewRpc(
    createLaneReview({ ...deps, lanes: createLanesStore(deps.db), reviews: createReviewStore(deps.db) }),
  );
}

export type LanesSuggestDeps = Omit<LaneSuggestDeps, "lanes"> & { readonly db: Db };

/** `lanes.suggestCommit` (Task 17): a commit message from the lane session's model. */
export function createLanesSuggest(deps: LanesSuggestDeps): LanesSuggestRpc {
  return lanesSuggestRpc(createLaneSuggest({ ...deps, lanes: createLanesStore(deps.db) }));
}
