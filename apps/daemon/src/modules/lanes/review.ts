import {
  type Caller,
  INVISIBLE,
  LANE_LIMITS,
  PapError,
  type ParamsOf,
  type ResultOf,
  type ReviewDoc,
} from "@pap/contracts";
import { checkpointRef, entryIdsOf, laneRefs } from "../../kernel/git/checkpoint.ts";
import { diffList } from "../../kernel/git/diff-lists.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { snapshotTree } from "../../kernel/git/snapshot.ts";
import { turnRanges, type TurnRange } from "../../kernel/git/turn-range.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cutUnits } from "../../kernel/text.ts";
import type { SessionsLanePort } from "../sessions/index.ts";
import { branchFiles } from "./branch-files.ts";
import { guardSnapshot } from "./disk-floor.ts";
import type { ReviewStore } from "./review-store.ts";
import type { LaneRow, LanesStore } from "./store.ts";
import { baseLabelOf } from "./view.ts";

/** The kernel git functions, replaceable in tests. */
export interface ReviewOps {
  readonly snapshotTree: typeof snapshotTree;
  readonly diffList: typeof diffList;
  readonly laneRefs: typeof laneRefs;
}

export interface LaneReviewDeps {
  /** The guarded runner built with the index folder (`composeWorkspace`'s). */
  readonly git: GitRunner;
  readonly logger: Logger;
  readonly lanes: Pick<LanesStore, "getOwned">;
  readonly reviews: ReviewStore;
  /** The git dir pap stored for the lane (MC3 I3), never one read from the lane. */
  gitDirOf(worktree: string): string | undefined;
  /** Where the temporary indexes of a snapshot live. */
  readonly indexDir: string;
  sessions(): Pick<SessionsLanePort, "sessionIdsIn" | "branchPath"> | undefined;
  readonly readOnly: boolean;
  /** Checked before a snapshot writes blobs (final review M5). */
  diskFloor(path: string): undefined;
  readonly ops?: ReviewOps;
}

export interface LaneReview {
  review(caller: Caller, params: ParamsOf<"lanes.review">): Promise<ResultOf<"lanes.review">>;
  turns(caller: Caller, params: ParamsOf<"lanes.turns">): Promise<ResultOf<"lanes.turns">>;
  stateGet(caller: Caller, laneId: string): ResultOf<"lanes.reviewState.get">;
  stateSet(caller: Caller, params: ParamsOf<"lanes.reviewState.set">): ResultOf<"lanes.reviewState.set">;
}

const EMPTY: ReviewDoc = { seen: [], comments: [] };
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "gu");
const short = (oid: string): string => oid.slice(0, 8);

export function createLaneReview(deps: LaneReviewDeps): LaneReview {
  const ops = deps.ops ?? { snapshotTree, diffList, laneRefs };

  const owned = (caller: Caller, laneId: string): LaneRow => {
    const row = deps.lanes.getOwned(caller.userId, laneId);
    if (!row) throw new PapError("not_found");
    return row;
  };
  /** A lane with files to read: git work on an archived or failed lane is `not_found`. */
  const live = (caller: Caller, laneId: string): { row: LaneRow; gitDir: string } => {
    const row = owned(caller, laneId);
    const gitDir = row.state === "active" ? deps.gitDirOf(row.worktree) : undefined;
    if (gitDir === undefined) throw new PapError("not_found");
    return { row, gitDir };
  };
  /** The session must be the caller's and inside the lane's folder; its branch is read through the sessions port. */
  async function pathOf(caller: Caller, row: LaneRow, sessionId: string) {
    const sessions = deps.sessions();
    if (!sessions) throw new PapError("capacity");
    if (!sessions.sessionIdsIn(caller.userId, row.worktree).includes(sessionId))
      throw new PapError("not_found");
    return (await sessions.branchPath(caller, sessionId)).entries;
  }
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      deps.logger.warn("lane_review_git_failed", { kind: error.kind });
      throw new PapError(error.kind === "timeout" ? "timeout" : "capacity");
    }
  }
  async function ranges(caller: Caller, row: LaneRow, gitDir: string, sessionId: string) {
    const entries = await pathOf(caller, row, sessionId);
    const refs = await ops.laneRefs(deps.git, row.worktree, gitDir, row.id);
    const commitOf = (key: string): string | undefined =>
      refs.get(checkpointRef(row.id, key === "root" ? "root" : { entryId: key }));
    return { turns: turnRanges(entries, entryIdsOf(refs, row.id)), commitOf };
  }

  return {
    async review(caller, { laneId, scope }) {
      const { row, gitDir } = live(caller, laneId);
      return guarded(async () => {
        const snapshot = async () => {
          guardSnapshot(deps, row.worktree);
          return (await ops.snapshotTree(deps.git, row.worktree, gitDir, deps.indexDir)).tree;
        };
        const list = (from: string, to: string) =>
          ops.diffList(deps.git, row.worktree, gitDir, from, to, deps.logger);
        if (scope.kind === "branch") {
          guardSnapshot(deps, row.worktree);
          const { base, tree, files, truncated } = await branchFiles(
            deps.git,
            row.worktree,
            gitDir,
            row.baseRef,
            row.baseOid,
            deps.indexDir,
            deps.logger,
            ops,
          );
          return {
            from: { oid: base, label: baseLabelOf(row.baseRef) },
            to: { kind: "live" as const, tree },
            files,
            truncated,
          };
        }
        const { turns, commitOf } = await ranges(caller, row, gitDir, scope.sessionId);
        const turn = turns.find((candidate) => candidate.userEntryId === scope.userEntryId);
        if (!turn) throw new PapError("not_found");
        // No checkpoint before the turn: the lane's base is the best start there is.
        const from = turn.from === null ? row.baseOid : commitOf(turn.from);
        const end = turn.to === "live" ? null : commitOf(turn.to);
        if (from === undefined || end === undefined) throw new PapError("not_found");
        const fromSide = { oid: from, label: turn.from === null ? baseLabelOf(row.baseRef) : short(from) };
        if (end === null) {
          const tree = await snapshot();
          const { files, truncated } = await list(from, tree);
          return { from: fromSide, to: { kind: "live" as const, tree }, files, truncated };
        }
        const { files, truncated } = await list(from, end);
        return {
          from: fromSide,
          to: { kind: "commit" as const, oid: end, label: short(end) },
          files,
          truncated,
        };
      });
    },

    async turns(caller, { laneId, sessionId }) {
      const { row, gitDir } = live(caller, laneId);
      return guarded(async () => {
        const { turns, commitOf } = await ranges(caller, row, gitDir, sessionId);
        const view = (turn: TurnRange) => ({
          index: turn.index,
          userEntryId: turn.userEntryId,
          preview: cutUnits(turn.preview.replace(INVISIBLE_ALL, ""), LANE_LIMITS.turnPreview),
          from: turn.from === null ? null : (commitOf(turn.from) ?? null),
          to: turn.to === "live" ? ("live" as const) : (commitOf(turn.to) ?? null),
        });
        const newest = turns.toReversed();
        return {
          turns: newest.slice(0, LANE_LIMITS.turns).map(view),
          truncated: newest.length > LANE_LIMITS.turns,
        };
      });
    },

    stateGet(caller, laneId) {
      owned(caller, laneId);
      const row = deps.reviews.get(caller.userId, laneId);
      return row
        ? { doc: JSON.parse(row.doc) as ReviewDoc, revision: row.revision }
        : { doc: EMPTY, revision: 0 };
    },

    stateSet(caller, { laneId, doc, baseRevision }) {
      owned(caller, laneId);
      if (deps.readOnly) throw new PapError("read_only");
      const text = JSON.stringify(doc);
      if (Buffer.byteLength(text, "utf8") > 1_048_576) throw new PapError("payload_too_large");
      const revision = deps.reviews.put(caller.userId, laneId, text, baseRevision);
      if (revision === null) throw new PapError("conflict");
      return { revision };
    },
  };
}
