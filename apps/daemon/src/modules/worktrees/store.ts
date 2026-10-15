import { LANE_LIMITS, PapError } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

export type WorktreeState = "creating" | "ready" | "removing";

export interface WorktreeRow {
  readonly path: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly repoRoot: string;
  readonly branch: string;
  /** The admin dir git created, read back and checked after `worktree add` (MC3 I3); null before that. */
  readonly gitDir: string | null;
  readonly baseOid: string;
  readonly createdBranch: boolean;
  readonly state: WorktreeState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a caller gives to phase 1; the owner, the state and the dates are the module's. */
export type NewWorktree = Pick<
  WorktreeRow,
  "path" | "workspaceId" | "repoRoot" | "branch" | "baseOid" | "createdBranch"
>;

export interface WorktreesStore {
  /** Phase 1, one transaction: the owner's creating cap, the caller's own checks, then the row `creating` (M9R17). */
  reserve(ownerId: string, row: NewWorktree, now: number, check: (tx: Db) => void): void;
  get(path: string): WorktreeRow | undefined;
  setGitDir(path: string, gitDir: string): void;
  setState(path: string, state: WorktreeState, now: number): void;
  delete(path: string): void;
  forOwner(ownerId: string): WorktreeRow[];
  /** Rows a crash may have left half-done, oldest first. */
  unfinished(): WorktreeRow[];
}

const COLUMNS = `path, owner_id AS ownerId, workspace_id AS workspaceId, repo_root AS repoRoot, branch, git_dir AS gitDir,
  base_oid AS baseOid, created_branch AS createdBranch, state, created_at AS createdAt, updated_at AS updatedAt`;

type Raw = Omit<WorktreeRow, "createdBranch"> & { createdBranch: number };
const rowOf = (raw: Raw): WorktreeRow => ({ ...raw, createdBranch: raw.createdBranch === 1 });

export function createWorktreesStore(db: Db): WorktreesStore {
  const one = (path: string) => db.get<Raw>(`SELECT ${COLUMNS} FROM worktrees WHERE path = $path`, { path });
  return {
    reserve: (ownerId, row, now, check) =>
      db.transaction(() => {
        const creating =
          db.get<{ n: number }>(
            "SELECT count(*) AS n FROM worktrees WHERE owner_id = $ownerId AND state = 'creating'",
            { ownerId },
          )?.n ?? 0;
        if (creating >= LANE_LIMITS.creatingPerOwner) throw new PapError("capacity");
        check(db);
        db.run(
          `INSERT INTO worktrees (path, owner_id, workspace_id, repo_root, branch, base_oid, created_branch, state, created_at, updated_at)
           VALUES ($path, $ownerId, $workspaceId, $repoRoot, $branch, $baseOid, $createdBranch, 'creating', $now, $now)`,
          {
            path: row.path,
            ownerId,
            workspaceId: row.workspaceId,
            repoRoot: row.repoRoot,
            branch: row.branch,
            baseOid: row.baseOid,
            createdBranch: row.createdBranch ? 1 : 0,
            now,
          },
        );
      }),
    get: (path) => {
      const raw = one(path);
      return raw && rowOf(raw);
    },
    setGitDir: (path, gitDir) => {
      db.run("UPDATE worktrees SET git_dir = $gitDir WHERE path = $path", { path, gitDir });
    },
    setState: (path, state, now) => {
      db.run("UPDATE worktrees SET state = $state, updated_at = $now WHERE path = $path", {
        path,
        state,
        now,
      });
    },
    delete: (path) => {
      db.run("DELETE FROM worktrees WHERE path = $path", { path });
    },
    forOwner: (ownerId) =>
      db
        .all<Raw>(`SELECT ${COLUMNS} FROM worktrees WHERE owner_id = $ownerId ORDER BY created_at, path`, {
          ownerId,
        })
        .map(rowOf),
    unfinished: () =>
      db
        .all<Raw>(
          `SELECT ${COLUMNS} FROM worktrees WHERE state IN ('creating', 'removing') ORDER BY created_at, path`,
        )
        .map(rowOf),
  };
}
