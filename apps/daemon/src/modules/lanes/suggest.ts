import { type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import { snapshotTree } from "../../kernel/git/snapshot.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cutUnits } from "../../kernel/text.ts";
import type { SessionsLanePort } from "../sessions/index.ts";
import { guardSnapshot } from "./disk-floor.ts";
import type { LanesStore } from "./store.ts";

/** Orca's clipping: a file's part of the diff, then the whole (M9R80). */
const FILE_CHARS = 20_000;
const DIFF_CHARS = 200_000;
const FILE_MARK = "\n[… clipped]\n";
const DIFF_MAX_BYTES = 32 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 60_000;
/** The call is paid and outside M10's budget: at most this many model calls in flight per owner. */
export const MAX_SUGGESTS_PER_OWNER = 2;

export interface LaneSuggestDeps {
  /** The guarded runner built with the index folder (`composeWorkspace`'s). */
  readonly git: GitRunner;
  readonly logger: Logger;
  readonly lanes: Pick<LanesStore, "getOwned">;
  /** The git dir pap stored for the lane (MC3 I3), never one read from the lane. */
  gitDirOf(worktree: string): string | undefined;
  /** Where the temporary indexes of a snapshot live. */
  readonly indexDir: string;
  /** Checked before the snapshot writes blobs (final review M5). */
  diskFloor(path: string): undefined;
  readonly readOnly: boolean;
  sessions(): Pick<SessionsLanePort, "suggestCommit"> | undefined;
  readonly ops?: { readonly snapshotTree: typeof snapshotTree };
}

export interface LaneSuggest {
  suggest(caller: Caller, params: ParamsOf<"lanes.suggestCommit">): Promise<ResultOf<"lanes.suggestCommit">>;
}

/** Each file's part clipped, then the whole: the model never reads more than 200 000 characters of the owner's diff. */
export function clipDiff(text: string): string {
  const parts = text.split(/^(?=diff --git )/m).map((part) => cutUnits(part, FILE_CHARS, FILE_MARK));
  return cutUnits(parts.join(""), DIFF_CHARS);
}

export function createLaneSuggest(deps: LaneSuggestDeps): LaneSuggest {
  const ops = deps.ops ?? { snapshotTree };
  // One request per lane at a time (a double click must not pay twice), and a few per owner across lanes.
  const flights = new Map<string, Promise<ResultOf<"lanes.suggestCommit">>>();
  const perOwner = new Map<string, number>();
  async function run(
    caller: Caller,
    { laneId, paths }: ParamsOf<"lanes.suggestCommit">,
  ): Promise<ResultOf<"lanes.suggestCommit">> {
    const row = deps.lanes.getOwned(caller.userId, laneId);
    const gitDir = row?.state === "active" ? deps.gitDirOf(row.worktree) : undefined;
    if (!row || gitDir === undefined) throw new PapError("not_found");
    const sessions = deps.sessions();
    if (!sessions) throw new PapError("capacity");
    if (row.primarySessionId === null) return { ok: false, reason: "no_session" };
    let diff: string;
    try {
      guardSnapshot(deps, row.worktree);
      // Only the selected paths are staged into the temporary index; ignored files are never in the tree.
      const { tree } = await ops.snapshotTree(deps.git, row.worktree, gitDir, deps.indexDir, paths);
      const out = await deps.git.run(row.worktree, ["diff", "--no-color", "-U3", "-M", "HEAD", tree, "--"], {
        gitDir,
        maxBytes: DIFF_MAX_BYTES,
        timeoutMs: DIFF_TIMEOUT_MS,
      });
      diff = clipDiff(out.stdout.toString("utf8"));
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      deps.logger.warn("lane_suggest_git_failed", { kind: error.kind });
      throw new PapError(error.kind === "timeout" ? "timeout" : "capacity");
    }
    if (diff.trim() === "") return { ok: false, reason: "nothing" };
    return sessions.suggestCommit(caller, row.primarySessionId, diff);
  }
  return {
    async suggest(caller, params) {
      const key = `${caller.userId}:${params.laneId}`;
      const joined = flights.get(key);
      if (joined) return joined;
      const count = perOwner.get(caller.userId) ?? 0;
      if (count >= MAX_SUGGESTS_PER_OWNER) throw new PapError("capacity");
      perOwner.set(caller.userId, count + 1);
      const flight = run(caller, params);
      flights.set(key, flight);
      const done = (): void => {
        if (flights.get(key) === flight) flights.delete(key);
        const left = (perOwner.get(caller.userId) ?? 1) - 1;
        if (left > 0) perOwner.set(caller.userId, left);
        else perOwner.delete(caller.userId);
      };
      flight.then(done, done);
      return flight;
    },
  };
}
