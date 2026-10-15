import { LANE_LIMITS, type LaneView } from "@pap/contracts";
import type { LaneRow } from "./store.ts";

/** What a base looks like in the header: the branch name, or the first characters of a commit. */
export const baseLabelOf = (baseRef: string): string =>
  /^[0-9a-f]{40,64}$/.test(baseRef) ? baseRef.slice(0, 8) : baseRef.replace(/^refs\/(?:heads|remotes)\//, "");

/** The parts of a view that come from the forge and the remote (Task 14); all null when nothing is known. */
export type Outward = Pick<LaneView, "pr" | "forge" | "remote" | "pushRemote">;
export const NO_OUTWARD: Outward = { pr: null, forge: null, remote: null, pushRemote: null };

/** The description's first characters, never ending on half a surrogate pair (the lane stream's frame is bounded, M2R54). */
export function previewOf(
  description: string,
): Pick<LaneView, "descriptionPreview" | "descriptionTruncated"> {
  if (description.length <= LANE_LIMITS.descriptionPreview)
    return { descriptionPreview: description, descriptionTruncated: false };
  const clipped = description.slice(0, LANE_LIMITS.descriptionPreview);
  const last = clipped.charCodeAt(clipped.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
  return { descriptionPreview: whole, descriptionTruncated: true };
}

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
    ...previewOf(row.description),
    notices,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}
