import type { LaneView } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import { parseNumstat } from "../../kernel/git/numstat.ts";
import { parsePorcelainV2 } from "../../kernel/git/porcelain.ts";
import type { LaneRow, LanesStore } from "./store.ts";

type Facts = NonNullable<LaneView["facts"]>;

/** Facts older than this are refreshed in the background when a lane's view is built (M9R42). */
export const FACTS_STALE_MS = 30_000;
const BACKGROUND_AT_ONCE = 2;

const STATUS = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--ignore-submodules=dirty",
  "--untracked-files=normal",
];

export interface FactsDeps {
  readonly git: GitRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: Pick<LanesStore, "get">;
  /** The git dir pap stored for the lane (MC3 I3), never one read from the lane. */
  gitDirOf(worktree: string): string | undefined;
  /** The facts of a lane changed: its view goes out on the lane stream. */
  changed(laneId: string): void;
}

export interface LaneFacts {
  /** What is known now; no look at the clock. */
  get(laneId: string): Facts | null;
  /** `get`, and a background refresh when the facts are missing or stale and the lane is active. */
  view(laneId: string): Facts | null;
  /** Waits for the refresh of this lane; a trigger during a run asks for exactly one more. */
  refresh(laneId: string): Promise<void>;
  /** The changed or untracked files now; throws `GitError`. */
  dirtyCount(lane: Pick<LaneRow, "worktree">): Promise<number>;
  forget(laneId: string): void;
  /** Every refresh started so far has ended. */
  settled(): Promise<void>;
}

const NULLS = {
  dirty: null,
  ahead: null,
  behind: null,
  unpushed: null,
  additions: null,
  deletions: null,
} as const;
const countOf = (stdout: Buffer): number => Number.parseInt(stdout.toString("utf8").trim(), 10);

export function createLaneFacts(deps: FactsDeps): LaneFacts {
  const { git, clock } = deps;
  const known = new Map<string, Facts>();
  const running = new Map<string, { again: boolean; done: Promise<void> }>();
  const waiting: string[] = [];
  let background = 0;

  function gitDirOrThrow(worktree: string): string {
    const gitDir = deps.gitDirOf(worktree);
    if (gitDir === undefined) throw new GitError("failed");
    return gitDir;
  }
  const statusOf = async (worktree: string, gitDir: string) =>
    parsePorcelainV2((await git.run(worktree, STATUS, { gitDir })).stdout);

  async function measure(row: LaneRow): Promise<Omit<Facts, "checkedAt" | "error">> {
    const gitDir = gitDirOrThrow(row.worktree);
    const status = await statusOf(row.worktree, gitDir);
    const lane = (args: string[]) => git.run(row.worktree, args, { gitDir });
    const base = (await lane(["merge-base", row.baseRef, "HEAD"])).stdout.toString("utf8").trim();
    const ahead = countOf((await lane(["rev-list", "--count", `${base}..HEAD`])).stdout);
    const behind = countOf((await lane(["rev-list", "--count", `${base}..${row.baseRef}`])).stdout);
    const rows = parseNumstat(
      (await lane(["diff", "--numstat", "-z", "--ignore-submodules=dirty", base, "--"])).stdout,
    );
    let additions = 0;
    let deletions = 0;
    for (const entry of rows.values()) {
      additions += entry.additions ?? 0;
      deletions += entry.deletions ?? 0;
    }
    return {
      dirty: status.entries.length,
      unpushed: status.branch.upstream === null ? null : status.branch.ahead,
      ahead,
      behind,
      additions,
      deletions,
    };
  }

  async function once(laneId: string): Promise<void> {
    const row = deps.store.get(laneId);
    if (!row || (row.state !== "active" && row.state !== "archiving")) return;
    let next: Facts;
    try {
      next = { ...(await measure(row)), checkedAt: clock.now(), error: null };
    } catch (error) {
      const kind = error instanceof GitError ? error.kind : "failed";
      if (!(error instanceof GitError)) deps.logger.warn("lane_facts_failed", { laneId, err: error });
      next = { ...NULLS, checkedAt: clock.now(), error: kind };
    }
    // The lane may have been archived while git ran: nothing is kept for it.
    if (deps.store.get(laneId)?.state === "archived") return;
    known.set(laneId, next);
    deps.changed(laneId);
  }

  function refresh(laneId: string): Promise<void> {
    const current = running.get(laneId);
    if (current) {
      current.again = true;
      return current.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      for (;;) {
        entry.again = false;
        await once(laneId);
        // Nothing awaits between this check and the delete: a trigger either set `again` before, or starts a new run.
        if (!entry.again) return void running.delete(laneId);
      }
    })();
    running.set(laneId, entry);
    return entry.done;
  }

  function pump(): void {
    while (background < BACKGROUND_AT_ONCE) {
      const laneId = waiting.shift();
      if (laneId === undefined) return;
      background += 1;
      void refresh(laneId)
        .catch((error: unknown) => deps.logger.error("lane_facts_refresh_failed", { err: error }))
        .finally(() => {
          background -= 1;
          pump();
        });
    }
  }

  return {
    get: (laneId) => known.get(laneId) ?? null,
    view(laneId) {
      const facts = known.get(laneId) ?? null;
      const stale = facts === null || clock.now() - facts.checkedAt > FACTS_STALE_MS;
      if (
        stale &&
        deps.store.get(laneId)?.state === "active" &&
        !running.has(laneId) &&
        !waiting.includes(laneId)
      ) {
        waiting.push(laneId);
        pump();
      }
      return facts;
    },
    refresh,
    async dirtyCount(lane) {
      return (await statusOf(lane.worktree, gitDirOrThrow(lane.worktree))).entries.length;
    },
    forget: (laneId) => void known.delete(laneId),
    async settled() {
      while (running.size > 0 || waiting.length > 0) {
        await Promise.allSettled([...running.values()].map((entry) => entry.done));
        await Promise.resolve();
      }
    },
  };
}
