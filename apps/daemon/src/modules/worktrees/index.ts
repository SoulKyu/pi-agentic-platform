import { fileURLToPath } from "node:url";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import { createWorktreesService, type WorktreesDeps, type WorktreesPort } from "./service.ts";

export { laneFolder } from "./paths.ts";
export { WorktreeFailure, type WorktreesPort } from "./service.ts";

export const WORKTREES_MIGRATIONS: MigrationSource = {
  module: "worktrees",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export function createWorktreesModule(deps: WorktreesDeps): WorktreesPort {
  return createWorktreesService({ ...deps, logger: deps.logger.child({ module: "worktrees" }) });
}
