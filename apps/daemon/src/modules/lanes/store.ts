import type { LaneView, ModelPick } from "@pap/contracts";

type LaneSource = LaneView["source"];
import type { Db } from "../../kernel/db/database.ts";

export type LaneState = LaneView["state"];
export type FailedReason = NonNullable<LaneView["failedReason"]>;
type SetupState = LaneView["setup"]["state"];
type TestState = LaneView["tests"]["state"];

/** A `lanes` row. The script columns are written by the script store (Task 5); this store owns the rest. */
export interface LaneRow {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly createdBy: "session" | "token";
  readonly projectRoot: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseOid: string;
  readonly title: string;
  readonly description: string;
  readonly source: LaneSource | null;
  readonly model: ModelPick | null;
  readonly primarySessionId: string | null;
  readonly fanoutId: string | null;
  readonly fanoutSlot: number | null;
  readonly setupState: SetupState;
  readonly setupExit: number | null;
  readonly setupStartedAt: number | null;
  readonly setupFinishedAt: number | null;
  readonly testState: TestState;
  readonly testExit: number | null;
  readonly testFinishedAt: number | null;
  readonly firstRunEndedAt: number | null;
  /** The lane's pull request, kept by `lanes.prCreate` (M9R70); the state is read from the forge. */
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly state: LaneState;
  readonly failedReason: FailedReason | null;
  readonly archivedAt: number | null;
  readonly createdAt: number;
}

/** What phase 1 of `lanes.create` writes; everything else starts at the schema's default. */
export type NewLane = Pick<
  LaneRow,
  | "id"
  | "ownerId"
  | "createdBy"
  | "projectRoot"
  | "worktree"
  | "branch"
  | "baseRef"
  | "baseOid"
  | "title"
  | "description"
  | "source"
  | "model"
> & { readonly fanoutId?: string; readonly fanoutSlot?: number };

export interface FanoutRow {
  readonly id: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly laneIds: string[];
}

export interface LanesStore {
  insert(lane: NewLane, now: number): void;
  /** The rows of a fan-out group: its prompt is the rendered first prompt (M9R81). */
  insertFanout(ownerId: string, id: string, prompt: string, now: number): void;
  /** Everything inside is one transaction (nested calls join it): a fan-out is reserved whole or not at all. */
  transaction<T>(fn: () => T): T;
  get(id: string): LaneRow | undefined;
  /** The lane when it is this owner's: another owner's lane is the same answer as a missing one. */
  getOwned(ownerId: string, id: string): LaneRow | undefined;
  /** Lanes that are not archived: creating, active, archiving and failed (the cap of 64 counts these). */
  countOpen(ownerId: string): number;
  setState(id: string, state: LaneState, extra?: { failedReason?: FailedReason; at?: number }): void;
  setPrimarySession(id: string, sessionId: string): void;
  setPr(id: string, number: number, url: string): void;
  /** The first run's end: written once, later calls change nothing. */
  markFirstRunEnded(id: string, at: number): void;
  /** The setup states pap itself decides (the runner writes the others). */
  setSetupState(id: string, state: "none" | "pending" | "unapproved" | "interrupted"): void;
  /** Non-archived lanes, newest first. */
  open(ownerId: string): LaneRow[];
  archivedCount(ownerId: string): number;
  /** Archived lanes by `(archived_at, id)` descending, strictly after `before`. */
  archivedPage(ownerId: string, before: { archivedAt: number; id: string } | null, limit: number): LaneRow[];
  fanouts(ownerId: string, ids: readonly string[]): FanoutRow[];
  /** Every lane that has (or had) a worktree: all but the failed ones. */
  tracked(): LaneRow[];
  /** Lanes a crash left in `creating`. */
  creating(): LaneRow[];
  /** Lanes a crash left in `archiving`. */
  archiving(): LaneRow[];
}

const COLUMNS = `id, owner_id AS ownerId, workspace_id AS workspaceId, created_by AS createdBy,
  project_root AS projectRoot, worktree, branch, base_ref AS baseRef, base_oid AS baseOid, title, description,
  source, model, primary_session_id AS primarySessionId, fanout_id AS fanoutId, fanout_slot AS fanoutSlot,
  setup_state AS setupState, setup_exit AS setupExit, setup_started_at AS setupStartedAt,
  setup_finished_at AS setupFinishedAt, test_state AS testState, test_exit AS testExit,
  test_finished_at AS testFinishedAt, first_run_ended_at AS firstRunEndedAt, pr_number AS prNumber, pr_url AS prUrl, state,
  failed_reason AS failedReason, archived_at AS archivedAt, created_at AS createdAt`;

type Raw = Omit<LaneRow, "source" | "model"> & { source: string | null; model: string | null };

/** The JSON columns are written by this store only and checked by the schema (`json_valid`). */
const rowOf = (raw: Raw): LaneRow => ({
  ...raw,
  source: raw.source === null ? null : (JSON.parse(raw.source) as LaneSource),
  model: raw.model === null ? null : (JSON.parse(raw.model) as ModelPick),
});

const NEWEST = "ORDER BY created_at DESC, id DESC";

export function createLanesStore(db: Db): LanesStore {
  const rows = (sql: string, params: Record<string, string | number> = {}): LaneRow[] =>
    db.all<Raw>(sql, params).map(rowOf);
  return {
    insert: (lane, now) => {
      db.run(
        `INSERT INTO lanes (id, owner_id, created_by, project_root, worktree, branch, base_ref, base_oid, title,
           description, source, model, fanout_id, fanout_slot, state, created_at)
         VALUES ($id, $ownerId, $createdBy, $projectRoot, $worktree, $branch, $baseRef, $baseOid, $title,
           $description, $source, $model, $fanoutId, $fanoutSlot, 'creating', $now)`,
        {
          id: lane.id,
          ownerId: lane.ownerId,
          createdBy: lane.createdBy,
          projectRoot: lane.projectRoot,
          worktree: lane.worktree,
          branch: lane.branch,
          baseRef: lane.baseRef,
          baseOid: lane.baseOid,
          title: lane.title,
          description: lane.description,
          source: lane.source === null ? null : JSON.stringify(lane.source),
          model: lane.model === null ? null : JSON.stringify(lane.model),
          fanoutId: lane.fanoutId ?? null,
          fanoutSlot: lane.fanoutSlot ?? null,
          now,
        },
      );
    },
    insertFanout: (ownerId, id, prompt, now) => {
      db.run(
        "INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ($id, $ownerId, $prompt, $now)",
        { id, ownerId, prompt, now },
      );
    },
    transaction: (fn) => db.transaction(fn),
    get: (id) => rows(`SELECT ${COLUMNS} FROM lanes WHERE id = $id`, { id })[0],
    getOwned: (ownerId, id) =>
      rows(`SELECT ${COLUMNS} FROM lanes WHERE id = $id AND owner_id = $ownerId`, { id, ownerId })[0],
    countOpen: (ownerId) =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM lanes WHERE owner_id = $ownerId AND state <> 'archived'",
        {
          ownerId,
        },
      )?.n ?? 0,
    setState: (id, state, extra = {}) => {
      db.run(
        `UPDATE lanes SET state = $state, failed_reason = $failedReason,
           archived_at = CASE WHEN $state = 'archived' THEN $at ELSE archived_at END WHERE id = $id`,
        { id, state, failedReason: extra.failedReason ?? null, at: extra.at ?? 0 },
      );
    },
    setPrimarySession: (id, sessionId) => {
      db.run("UPDATE lanes SET primary_session_id = $sessionId WHERE id = $id", { id, sessionId });
    },
    setPr: (id, number, url) => {
      db.run("UPDATE lanes SET pr_number = $number, pr_url = $url WHERE id = $id", { id, number, url });
    },
    markFirstRunEnded: (id, at) => {
      db.run("UPDATE lanes SET first_run_ended_at = $at WHERE id = $id AND first_run_ended_at IS NULL", {
        id,
        at,
      });
    },
    setSetupState: (id, state) => {
      db.run("UPDATE lanes SET setup_state = $state WHERE id = $id", { id, state });
    },
    open: (ownerId) =>
      rows(`SELECT ${COLUMNS} FROM lanes WHERE owner_id = $ownerId AND state <> 'archived' ${NEWEST}`, {
        ownerId,
      }),
    archivedCount: (ownerId) =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM lanes WHERE owner_id = $ownerId AND state = 'archived'",
        {
          ownerId,
        },
      )?.n ?? 0,
    archivedPage: (ownerId, before, limit) =>
      rows(
        `SELECT ${COLUMNS} FROM lanes WHERE owner_id = $ownerId AND state = 'archived'
           AND ($hasBefore = 0 OR (archived_at, id) < ($archivedAt, $id))
         ORDER BY archived_at DESC, id DESC LIMIT $limit`,
        {
          ownerId,
          hasBefore: before === null ? 0 : 1,
          archivedAt: before?.archivedAt ?? 0,
          id: before?.id ?? "",
          limit,
        },
      ),
    fanouts: (ownerId, ids) => {
      const found: FanoutRow[] = [];
      for (const id of ids) {
        const head = db.get<{ id: string; prompt: string; createdAt: number }>(
          "SELECT id, prompt, created_at AS createdAt FROM lane_fanouts WHERE id = $id AND owner_id = $ownerId",
          { id, ownerId },
        );
        if (!head) continue;
        const laneIds = db
          .all<{ id: string }>("SELECT id FROM lanes WHERE fanout_id = $id ORDER BY fanout_slot, id", { id })
          .map((lane) => lane.id);
        found.push({ ...head, laneIds });
      }
      return found;
    },
    tracked: () => rows(`SELECT ${COLUMNS} FROM lanes WHERE state <> 'failed' ORDER BY created_at, id`),
    creating: () => rows(`SELECT ${COLUMNS} FROM lanes WHERE state = 'creating' ORDER BY created_at, id`),
    archiving: () => rows(`SELECT ${COLUMNS} FROM lanes WHERE state = 'archiving' ORDER BY created_at, id`),
  };
}
