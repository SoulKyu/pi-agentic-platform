import type { Logger } from "../../kernel/logger.ts";
import type { WorktreesPort } from "../worktrees/index.ts";
import type { LanePathsIndex } from "./paths.ts";
import type { LaneConfig } from "./preview.ts";
import type { LaneRow, LanesStore } from "./store.ts";

export interface RecoverDeps {
  readonly store: LanesStore;
  readonly worktrees: Pick<WorktreesPort, "byPath">;
  readonly approved: LaneConfig["approvedScript"];
  readonly paths: Pick<LanePathsIndex, "rebuild">;
  readonly logger: Logger;
  readonly readOnly: boolean;
  /** An `archiving` lane goes on from the worker release; the archive script is not run again (M9R41). */
  resume(lane: LaneRow): void;
}

/** The setup state of a lane a crash left `creating` with a ready worktree (the life table's row 4). */
async function setupAfterCrash(
  deps: RecoverDeps,
  lane: LaneRow,
): Promise<"none" | "pending" | "unapproved" | "interrupted"> {
  const found = await deps
    .approved(lane.ownerId, lane.projectRoot, "setup")
    .catch(() => ({ ok: false as const, reason: "none" as const }));
  // A token's lane waits for the owner's click, whatever its setup says (M9R110).
  if (lane.createdBy === "token") return found.ok || found.reason === "unapproved" ? "pending" : "none";
  if (found.ok) return "interrupted";
  return found.reason === "unapproved" ? "unapproved" : "none";
}

/**
 * After `worktrees.recover` and the script orphans (M9R116): a `creating` lane becomes `failed` or `active`, an `archiving`
 * one is finished. A read-only database changes nothing. The lane's rows are written here; the git work happens in `resume`.
 */
export async function recoverLanes(deps: RecoverDeps): Promise<void> {
  if (deps.readOnly) {
    deps.logger.info("lane_recovery_skipped", { reason: "read_only" });
    return;
  }
  for (const lane of deps.store.creating()) {
    if (deps.worktrees.byPath(lane.worktree)?.state === "ready") {
      deps.store.setSetupState(lane.id, await setupAfterCrash(deps, lane));
      deps.store.setState(lane.id, "active");
    } else deps.store.setState(lane.id, "failed", { failedReason: "interrupted" });
  }
  deps.paths.rebuild();
  for (const lane of deps.store.archiving()) deps.resume(lane);
}
