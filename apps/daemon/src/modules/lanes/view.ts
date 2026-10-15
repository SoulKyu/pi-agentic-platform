import type { LaneView } from "@pap/contracts";
import type { LaneRow } from "./store.ts";

/** What a base looks like in the header: the branch name, or the first characters of a commit. */
export const baseLabelOf = (baseRef: string): string =>
  /^[0-9a-f]{40,64}$/.test(baseRef) ? baseRef.slice(0, 8) : baseRef.replace(/^refs\/(?:heads|remotes)\//, "");

/** The parts of a view that come from the forge and the remote (Task 14); all null when nothing is known. */
export type Outward = Pick<LaneView, "pr" | "forge" | "remote" | "pushRemote">;
export const NO_OUTWARD: Outward = { pr: null, forge: null, remote: null, pushRemote: null };

/** The wire view of a lane. `checkpointsFull` is the checkpoint cap's flag (Task 15). */
export function viewOf(
  row: LaneRow,
  notices: LaneView["notices"],
  facts: LaneView["facts"] = null,
  outward: Outward = NO_OUTWARD,
  checkpointsFull = false,
): LaneView {
  return {
    id: row.id,
    projectRoot: row.projectRoot,
    worktree: row.worktree,
    title: row.title,
    branch: row.branch,
    baseRef: row.baseRef,
    baseLabel: baseLabelOf(row.baseRef),
    primarySessionId: row.primarySessionId,
    createdBy: row.createdBy,
    state: row.state,
    failedReason: row.failedReason,
    setup: {
      state: row.setupState,
      exitCode: row.setupExit,
      startedAt: row.setupStartedAt,
      finishedAt: row.setupFinishedAt,
    },
    tests: { state: row.testState, exitCode: row.testExit, finishedAt: row.testFinishedAt },
    facts,
    ...outward,
    source: row.source ?? { kind: "description" },
    model: row.model,
    fanoutId: row.fanoutId,
    fanoutSlot: row.fanoutSlot,
    firstRunEndedAt: row.firstRunEndedAt,
    checkpointsFull,
    notices,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}
