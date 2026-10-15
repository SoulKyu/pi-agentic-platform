import { type Caller, INVISIBLE, LANE_LIMITS, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cutUnits } from "../../kernel/text.ts";
import type { SessionsLanePort } from "../sessions/index.ts";
import { guardSnapshot } from "./disk-floor.ts";
import { branchFiles } from "./branch-files.ts";
import type { LaneRow, LanesStore } from "./store.ts";

type Column = ResultOf<"lanes.compare">["columns"][number];

export interface CompareDeps {
  /** The guarded runner built with the index folder (`composeWorkspace`'s): temporary indexes only there. */
  readonly git: GitRunner;
  readonly logger: Logger;
  readonly store: Pick<LanesStore, "fanouts" | "getOwned">;
  /** The git dir pap stored for the lane (MC3 I3), never one read from the lane. */
  gitDirOf(worktree: string): string | undefined;
  readonly indexDir: string;
  /** Checked before the snapshot writes blobs (final review M5). */
  diskFloor(path: string): undefined;
  readonly readOnly: boolean;
  sessions(): Pick<SessionsLanePort, "lastAgentText"> | undefined;
  /** M10's `RunsPort.sessionCost` (wired by `compose-lanes.ts`): null for a session the runs registry does not know. */
  readonly sessionCost?: (sessionId: string) => number | null;
  /** M10's `RunsPort.sessionBilling`: the column's "API-equivalent" label. */
  readonly sessionBilling?: (sessionId: string) => "api" | "subscription" | "unknown" | null;
}

const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "gu");

/**
 * `lanes.compare` (M9R85): one column per lane of a group, from facts alone. No verdict and no ranking (decision 30).
 * The file counts are the Review pane's branch list (`merge-base` of the base and HEAD against the files now), read
 * through the guarded runner from the stored git dir; a lane git cannot answer for gets null counts, not an error.
 */
export function createCompare(deps: CompareDeps) {
  async function counts(row: LaneRow): Promise<Pick<Column, "files" | "additions" | "deletions">> {
    const none = { files: null, additions: null, deletions: null };
    const gitDir = row.state === "active" ? deps.gitDirOf(row.worktree) : undefined;
    if (gitDir === undefined) return none;
    // A read-only daemon writes no blobs: the column has no counts, like a lane git cannot answer for.
    if (deps.readOnly) return none;
    try {
      guardSnapshot(deps, row.worktree);
      const { files } = await branchFiles(
        deps.git,
        row.worktree,
        gitDir,
        row.baseRef,
        row.baseOid,
        deps.indexDir,
        deps.logger,
      );
      return {
        files: files.length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      deps.logger.warn("lane_compare_git_failed", { laneId: row.id, kind: error.kind });
      return none;
    }
  }

  async function summaryOf(row: LaneRow): Promise<string | null> {
    if (row.primarySessionId === null) return null;
    const sessions = deps.sessions();
    if (!sessions) throw new PapError("capacity");
    const text = await sessions.lastAgentText(row.primarySessionId, LANE_LIMITS.summary);
    return text === null ? null : cutUnits(text.replace(INVISIBLE_ALL, ""), LANE_LIMITS.summary);
  }

  return async function compare(
    caller: Caller,
    params: ParamsOf<"lanes.compare">,
  ): Promise<ResultOf<"lanes.compare">> {
    const fanout = deps.store.fanouts(caller.userId, [params.fanoutId])[0];
    if (!fanout) throw new PapError("not_found");
    const columns: Column[] = [];
    for (const laneId of fanout.laneIds) {
      const row = deps.store.getOwned(caller.userId, laneId);
      if (!row) continue;
      columns.push({
        laneId: row.id,
        summary: await summaryOf(row),
        ...(await counts(row)),
        durationMs: row.firstRunEndedAt === null ? null : Math.max(0, row.firstRunEndedAt - row.createdAt),
        costUsd: row.primarySessionId === null ? null : (deps.sessionCost?.(row.primarySessionId) ?? null),
        billing: row.primarySessionId === null ? null : (deps.sessionBilling?.(row.primarySessionId) ?? null),
      });
    }
    return { columns };
  };
}
