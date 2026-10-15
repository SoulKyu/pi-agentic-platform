import type { ScriptKind } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

export type ScriptStateName =
  "none" | "queued" | "pending" | "running" | "ok" | "failed" | "passed" | "interrupted" | "unapproved";

export interface ScriptState {
  readonly state: ScriptStateName;
  readonly exitCode: number | null;
}

export interface LaneRef {
  readonly id: string;
  readonly ownerId: string;
  /** The main checkout: `PAP_LANE_ROOT`, and where the approved script text is read (Task 4). */
  readonly projectRoot: string;
  /** The lane's folder: the script's cwd and `PAP_LANE_WORKTREE`. */
  readonly worktree: string;
}

export interface ScriptPatch {
  readonly state: ScriptStateName;
  readonly exitCode?: number | null;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface Leftover {
  readonly laneId: string;
  readonly pgid: number | null;
  readonly proc: string | null;
}

export interface ScriptStore {
  laneOf(laneId: string): LaneRef | undefined;
  read(laneId: string, kind: ScriptKind): ScriptState;
  /** `archive` has no column (its state lives in the runner): this is a no-op for it. */
  write(laneId: string, kind: ScriptKind, patch: ScriptPatch): void;
  setProc(laneId: string, pgid: number, proc: string): void;
  clearProc(laneId: string): void;
  /** Lanes a crash left with a script `queued` or `running`, or with a process group recorded. */
  leftovers(): Leftover[];
  /** `queued` and `running` become `interrupted`, and the process columns are cleared. */
  interrupt(laneId: string): void;
}

/** The columns of each kind: a closed table, so no SQL text is ever built from input. */
const COLUMNS = {
  setup: {
    state: "setup_state",
    exit: "setup_exit",
    started: "setup_started_at",
    finished: "setup_finished_at",
  },
  test: { state: "test_state", exit: "test_exit", started: null, finished: "test_finished_at" },
} as const;

/** The script columns of `lanes`: Task 6b's lane store owns the rest of the row. */
export function createScriptStore(db: Db): ScriptStore {
  return {
    laneOf: (laneId) =>
      db.get<LaneRef>(
        "SELECT id, owner_id AS ownerId, project_root AS projectRoot, worktree FROM lanes WHERE id = $laneId",
        { laneId },
      ),
    read(laneId, kind) {
      if (kind === "archive") return { state: "none", exitCode: null };
      const c = COLUMNS[kind];
      const row = db.get<{ state: ScriptStateName; exitCode: number | null }>(
        `SELECT ${c.state} AS state, ${c.exit} AS exitCode FROM lanes WHERE id = $laneId`,
        { laneId },
      );
      return row ?? { state: "none", exitCode: null };
    },
    write(laneId, kind, patch) {
      if (kind === "archive") return;
      const c = COLUMNS[kind];
      const sets = [`${c.state} = $state`];
      const params: Record<string, string | number | null> = { laneId, state: patch.state };
      if (patch.exitCode !== undefined) {
        sets.push(`${c.exit} = $exit`);
        params.exit = patch.exitCode;
      }
      if (patch.startedAt !== undefined && c.started) {
        sets.push(`${c.started} = $startedAt`);
        params.startedAt = patch.startedAt;
      }
      if (patch.finishedAt !== undefined) {
        sets.push(`${c.finished} = $finishedAt`);
        params.finishedAt = patch.finishedAt;
      }
      db.run(`UPDATE lanes SET ${sets.join(", ")} WHERE id = $laneId`, params);
    },
    setProc(laneId, pgid, proc) {
      db.run("UPDATE lanes SET script_pgid = $pgid, script_proc = $proc WHERE id = $laneId", {
        laneId,
        pgid,
        proc,
      });
    },
    clearProc(laneId) {
      db.run("UPDATE lanes SET script_pgid = NULL, script_proc = NULL WHERE id = $laneId", { laneId });
    },
    leftovers: () =>
      db.all<Leftover>(
        `SELECT id AS laneId, script_pgid AS pgid, script_proc AS proc FROM lanes
         WHERE script_pgid IS NOT NULL OR setup_state IN ('queued', 'running') OR test_state IN ('queued', 'running')`,
      ),
    interrupt(laneId) {
      db.transaction(() => {
        db.run(
          `UPDATE lanes SET
             setup_state = CASE WHEN setup_state IN ('queued', 'running') THEN 'interrupted' ELSE setup_state END,
             test_state = CASE WHEN test_state IN ('queued', 'running') THEN 'interrupted' ELSE test_state END,
             script_pgid = NULL, script_proc = NULL
           WHERE id = $laneId`,
          { laneId },
        );
      });
    },
  };
}
