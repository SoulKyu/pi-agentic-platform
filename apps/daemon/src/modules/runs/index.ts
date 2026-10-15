import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { scrubKnownSecrets } from "../audit/index.ts";
import { runLine } from "./export-jsonl.ts";
import { createRunsService, type ObservabilityFacts, type RunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";

export { runsRpc, type RunsRpc, usageRpc, type UsageRpc } from "./rpc.ts";
export type { RunEndEvent, RunObserver, RunsPort, RunsService, RunStartEvent } from "./service.ts";
export { metricsAuthorized } from "./metrics-auth.ts";
export { registerRunsMetrics } from "./metrics.ts";
export { createResume, type Resume } from "./resume.ts";
/**
 * The receipt of a resume (`resume:<session>:<run>:<resetAt>`): what the task runner's Cancel names at the join.
 * @public
 */
export { resumeKey } from "./resume.ts";
export { createUsageStream, type UsageStream } from "./usage-stream.ts";
export type { ResumeDeps } from "./resume.ts";
export type { RunsStore } from "./store.ts";

export const RUNS_MIGRATIONS: MigrationSource = {
  module: "runs",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

/** The registry over `db`; `appendLine` is where an ended run's `runs.jsonl` line goes (it may throw). */
export function createRunsModule(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  appendLine(line: string): void;
  readonly observability?: ObservabilityFacts;
}): RunsService {
  return createRunsService({
    store: createRunsStore(deps.db),
    clock: deps.clock,
    logger: deps.logger,
    newId: randomUUID,
    exportRun: (row) => deps.appendLine(runLine(row, scrubKnownSecrets)),
    ...(deps.observability ? { observability: deps.observability } : {}),
  });
}
