import { CLAUDE_BRIDGE_PROVIDER } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted" | "limited";
export type RunBilling = "api" | "subscription" | "unknown";
export type RunErrorClass =
  "provider" | "usage_limit" | "aborted" | "crash" | "deadline" | "run_budget" | "budget";

/** One row of `runs`: ids, counts and money only (M10R83). */
export interface RunRow {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly origin: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly billing: RunBilling;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly errorClass: RunErrorClass | null;
  readonly limitResetAt: number | null;
}

/** What a run has used so far: written to the row after each message, so a crash keeps it. */
export interface RunProgress {
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly toolCalls: number;
}

export interface RunFinish extends RunProgress {
  readonly status: Exclude<RunStatus, "running">;
  readonly endedAt: number;
  readonly billing: RunBilling;
  readonly errorClass: RunErrorClass | null;
  readonly limitResetAt: number | null;
}

export interface UsageBucket {
  readonly costUsd: number;
  readonly tokens: number;
  readonly runs: number;
}
export interface OriginBucket extends UsageBucket {
  readonly origin: string;
}
export interface ModelBucket extends UsageBucket {
  readonly provider: string;
  readonly model: string;
  readonly billing: RunBilling;
}

export interface RunsStore {
  insertRunning(run: {
    readonly id: string;
    readonly ownerId: string;
    readonly sessionId: string;
    readonly taskId: string | null;
    readonly origin: string;
    readonly startedAt: number;
    /** The agent whose session ran it, and the parent of a subagent's child (M11R73). */
    readonly agentId?: string | null;
    readonly parentSessionId?: string | null;
  }): void;
  saveProgress(id: string, progress: RunProgress): void;
  /** Closes a running row; undefined when there is none (already closed, or never opened). */
  finish(id: string, finish: RunFinish): RunRow | undefined;
  get(id: string): RunRow | undefined;
  running(): RunRow[];
  /** Runs `fn` in one transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T;
  /** The session's newest run, whatever its state; undefined when it has had none. */
  latestOf(sessionId: string): RunRow | undefined;
  /** The session's newest run other than `exceptId` (the one that just started). */
  latestBefore(sessionId: string, exceptId: string): RunRow | undefined;
  /** Runs started in the session after `run` (a run that began at the same instant counts when it is another one). */
  newerThan(run: RunRow): boolean;
  /** The owner's sessions whose newest run is `limited`, newest first (M10R107). */
  limitedSessions(ownerId: string, limit: number): RunRow[];
  /**
   * The cost of the finished runs the owner's automation ended since `since` (by `ended_at`: a run that crosses midnight counts when it ends, never lowering the day's total): every run with a task and every `resume` run
   * (spec C §6.4). `taskIds` narrows it to those tasks; an empty list is nothing.
   */
  spentSince(ownerId: string, since: number, taskIds: readonly string[] | null): number;
  /** The cost of every finished run of the owner, interactive included, billed `api` or `unknown` and not through the Claude bridge (the owner's own subscription), ended since `since` (M14 member line). */
  spentApiSince(ownerId: string, since: number): number;
  /** The finished runs of a session: how many, and what they cost. */
  sessionTotals(sessionId: string): { runs: number; costUsd: number };
  /** How the session's finished runs were billed: `subscription` if any was, else `api` if any was, else `unknown`; null with none. */
  sessionBilling(sessionId: string): RunBilling | null;
  totals(ownerId: string, from: number, to: number): UsageBucket;
  byOrigin(ownerId: string, from: number, to: number): OriginBucket[];
  byModel(ownerId: string, from: number, to: number): ModelBucket[];
}

interface Raw {
  id: string;
  owner_id: string;
  workspace_id: string;
  session_id: string;
  task_id: string | null;
  origin: string;
  status: RunStatus;
  started_at: number;
  ended_at: number | null;
  provider: string | null;
  model: string | null;
  billing: RunBilling;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  turns: number;
  tool_calls: number;
  error_class: RunErrorClass | null;
  limit_reset_at: number | null;
}

const rowOf = (raw: Raw): RunRow => ({
  id: raw.id,
  ownerId: raw.owner_id,
  workspaceId: raw.workspace_id,
  sessionId: raw.session_id,
  taskId: raw.task_id,
  origin: raw.origin,
  status: raw.status,
  startedAt: raw.started_at,
  endedAt: raw.ended_at,
  provider: raw.provider,
  model: raw.model,
  billing: raw.billing,
  inputTokens: raw.input_tokens,
  outputTokens: raw.output_tokens,
  cacheReadTokens: raw.cache_read_tokens,
  cacheWriteTokens: raw.cache_write_tokens,
  costUsd: raw.cost_usd,
  turns: raw.turns,
  toolCalls: raw.tool_calls,
  errorClass: raw.error_class,
  limitResetAt: raw.limit_reset_at,
});

const TOKENS = "(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)";
const MAX_GROUPS = 1000;
/** A run ends within 48 h of its start (run deadlines are far shorter): this bound keeps `runs_owner_started` usable for `ended_at` sums. */
const MAX_RUN_SPAN_MS = 172_800_000;
const PROGRESS_SET =
  "provider = $provider, model = $model, input_tokens = $inputTokens, output_tokens = $outputTokens, " +
  "cache_read_tokens = $cacheReadTokens, cache_write_tokens = $cacheWriteTokens, cost_usd = $costUsd, " +
  "turns = $turns, tool_calls = $toolCalls";
// The automation's own runs: a run with a task, and a resumed one (spec C §6.4).
const NEWEST = "ORDER BY started_at DESC, id DESC LIMIT 1";
const AUTOMATIC = "(task_id IS NOT NULL OR origin = 'resume')";

const progressParams = (progress: RunProgress) => ({
  provider: progress.provider,
  model: progress.model,
  inputTokens: progress.inputTokens,
  outputTokens: progress.outputTokens,
  cacheReadTokens: progress.cacheReadTokens,
  cacheWriteTokens: progress.cacheWriteTokens,
  costUsd: progress.costUsd,
  turns: progress.turns,
  toolCalls: progress.toolCalls,
});

export function createRunsStore(db: Db): RunsStore {
  const range = (ownerId: string, from: number, to: number) => ({ ownerId, from, to });
  return {
    insertRunning: (run) =>
      void db.run(
        "INSERT INTO runs (id, owner_id, session_id, task_id, origin, status, started_at, agent_id, parent_session_id) " +
          "VALUES ($id, $ownerId, $sessionId, $taskId, $origin, 'running', $startedAt, $agentId, $parentSessionId)",
        { agentId: null, parentSessionId: null, ...run },
      ),
    saveProgress: (id, progress) =>
      void db.run(`UPDATE runs SET ${PROGRESS_SET} WHERE id = $id AND status = 'running'`, {
        id,
        ...progressParams(progress),
      }),
    finish(id, finish) {
      const raw = db.get<Raw>(
        `UPDATE runs SET ${PROGRESS_SET}, status = $status, ended_at = $endedAt, billing = $billing, ` +
          "error_class = $errorClass, limit_reset_at = $limitResetAt WHERE id = $id AND status = 'running' RETURNING *",
        {
          id,
          ...progressParams(finish),
          status: finish.status,
          endedAt: finish.endedAt,
          billing: finish.billing,
          errorClass: finish.errorClass,
          limitResetAt: finish.limitResetAt,
        },
      );
      return raw && rowOf(raw);
    },
    get(id) {
      const raw = db.get<Raw>("SELECT * FROM runs WHERE id = $id", { id });
      return raw && rowOf(raw);
    },
    running: () =>
      db.all<Raw>("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at, id").map(rowOf),
    transaction: (fn) => db.transaction(fn),
    latestOf(sessionId) {
      const raw = db.get<Raw>(`SELECT * FROM runs WHERE session_id = $sessionId ${NEWEST}`, { sessionId });
      return raw && rowOf(raw);
    },
    latestBefore(sessionId, exceptId) {
      const raw = db.get<Raw>(
        `SELECT * FROM runs WHERE session_id = $sessionId AND id <> $exceptId ${NEWEST}`,
        {
          sessionId,
          exceptId,
        },
      );
      return raw && rowOf(raw);
    },
    newerThan: (run) =>
      db.get<{ n: number }>(
        "SELECT 1 AS n FROM runs WHERE session_id = $sessionId AND id <> $id AND started_at >= $startedAt LIMIT 1",
        { sessionId: run.sessionId, id: run.id, startedAt: run.startedAt },
      ) !== undefined,
    limitedSessions: (ownerId, limit) =>
      db
        .all<Raw>(
          "SELECT * FROM runs AS r WHERE owner_id = $ownerId AND status = 'limited' AND NOT EXISTS " +
            "(SELECT 1 FROM runs AS n WHERE n.session_id = r.session_id AND n.id <> r.id AND " +
            "(n.started_at > r.started_at OR (n.started_at = r.started_at AND n.id > r.id))) " +
            "ORDER BY ended_at DESC, id DESC LIMIT $limit",
          { ownerId, limit },
        )
        .map(rowOf),
    spentSince(ownerId, since, taskIds) {
      if (taskIds !== null && taskIds.length === 0) return 0;
      const common = `owner_id = $ownerId AND status <> 'running' AND ended_at >= $since AND started_at >= $since - ${MAX_RUN_SPAN_MS} AND ${AUTOMATIC}`;
      const row =
        taskIds === null
          ? db.get<{ total: number }>(
              `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE ${common}`,
              {
                ownerId,
                since,
              },
            )
          : db.get<{ total: number }>(
              `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE ${common} ` +
                "AND task_id IN (SELECT value FROM json_each($ids))",
              { ownerId, since, ids: JSON.stringify(taskIds) },
            );
      return row?.total ?? 0;
    },
    spentApiSince: (ownerId, since) =>
      db.get<{ total: number }>(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE owner_id = $ownerId AND status <> 'running' " +
          "AND billing IN ('api', 'unknown') AND COALESCE(provider, '') <> $bridge " +
          `AND ended_at >= $since AND started_at >= $since - ${MAX_RUN_SPAN_MS}`,
        { ownerId, since, bridge: CLAUDE_BRIDGE_PROVIDER },
      )?.total ?? 0,
    sessionTotals(sessionId) {
      const row = db.get<{ runs: number; costUsd: number }>(
        "SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd FROM runs " +
          "WHERE (session_id = $sessionId OR parent_session_id = $sessionId) AND status <> 'running'",
        { sessionId },
      );
      return { runs: row?.runs ?? 0, costUsd: row?.costUsd ?? 0 };
    },
    sessionBilling(sessionId) {
      const kinds = new Set(
        db
          .all<{ billing: RunBilling }>(
            "SELECT DISTINCT billing FROM runs WHERE (session_id = $sessionId OR parent_session_id = $sessionId) AND status <> 'running'",
            { sessionId },
          )
          .map((row) => row.billing),
      );
      if (kinds.size === 0) return null;
      return kinds.has("subscription") ? "subscription" : kinds.has("api") ? "api" : "unknown";
    },
    totals(ownerId, from, to) {
      const row = db.get<UsageBucket>(
        `SELECT COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(${TOKENS}), 0) AS tokens, COUNT(*) AS runs ` +
          "FROM runs WHERE owner_id = $ownerId AND started_at >= $from AND started_at <= $to",
        range(ownerId, from, to),
      );
      return row ?? { costUsd: 0, tokens: 0, runs: 0 };
    },
    byOrigin: (ownerId, from, to) =>
      db.all<OriginBucket>(
        `SELECT origin, SUM(cost_usd) AS costUsd, SUM(${TOKENS}) AS tokens, COUNT(*) AS runs FROM runs ` +
          "WHERE owner_id = $ownerId AND started_at >= $from AND started_at <= $to " +
          `GROUP BY origin ORDER BY costUsd DESC, origin LIMIT ${MAX_GROUPS}`,
        range(ownerId, from, to),
      ),
    byModel: (ownerId, from, to) =>
      db.all<ModelBucket>(
        "SELECT COALESCE(provider, 'none') AS provider, COALESCE(model, 'none') AS model, billing, " +
          `SUM(cost_usd) AS costUsd, SUM(${TOKENS}) AS tokens, COUNT(*) AS runs FROM runs ` +
          "WHERE owner_id = $ownerId AND started_at >= $from AND started_at <= $to " +
          `GROUP BY provider, model, billing ORDER BY costUsd DESC, provider, model LIMIT ${MAX_GROUPS}`,
        range(ownerId, from, to),
      ),
  };
}
