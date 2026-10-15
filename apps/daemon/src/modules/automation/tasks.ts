import {
  AUTOMATION_MODES,
  type TaskState,
  TASK_TERMINAL_STATES,
  TASKS_LIMITS,
  ToolAllowlist,
} from "@pap/contracts";
import { z } from "zod";
import type { Db } from "../../kernel/db/database.ts";

/** A `tasks` row as stored. `prompt` is never logged and never on a stream. */
export interface TaskRow {
  readonly id: string;
  readonly owner_id: string;
  readonly trigger_id: string | null;
  readonly origin: string;
  readonly state: TaskState;
  readonly reason: string | null;
  readonly cwd: string;
  readonly prompt: string;
  readonly tainted: number;
  readonly gated: number;
  readonly policy: string;
  readonly title: string;
  readonly detail: string | null;
  readonly session_id: string | null;
  readonly retry_of: string | null;
  readonly retry_on_interrupt: number;
  readonly max_run_ms: number;
  readonly max_run_usd: number | null;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}
/** A row with what the board shows of its trigger: the name and the project; both null once the trigger is deleted. */
export interface TaskJoined extends TaskRow {
  readonly trigger_name: string | null;
  readonly project_id: string | null;
}

/** What the trigger said when the task fired (M10R37): a later edit of the trigger never changes a fired task. */
export const TaskPolicySnapshot = z
  .object({
    mode: z.enum(AUTOMATION_MODES),
    tools: ToolAllowlist,
    preset: z.enum(["read-only", "full"]),
    env: z.array(z.string().max(64)).max(16),
  })
  .strict();
export type TaskPolicySnapshot = z.infer<typeof TaskPolicySnapshot>;

/** The stored snapshot, or null when it no longer parses: a task that cannot be read never starts. */
export function parsePolicy(json: string): TaskPolicySnapshot | null {
  try {
    const parsed = TaskPolicySnapshot.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Controls, format characters (bidi, zero-width) and line or paragraph separators: never shown, never stored.
// eslint-disable-next-line no-control-regex -- the control characters are what this pattern removes
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * The payload's first line for the board (M10R43): at most 120 code points, with controls and format characters removed.
 * Untrusted text; the UI still shows it fenced.
 */
export function detailOf(text: string | null | undefined): string | null {
  if (text == null) return null;
  const firstLine = text.split(/\r\n|[\n\r\u2028\u2029]/, 1)[0] ?? "";
  const clean = [...firstLine.replace(HIDDEN, "")].slice(0, TASKS_LIMITS.detailChars).join("").trim();
  return clean === "" ? null : clean;
}

export interface NewTask {
  readonly id: string;
  readonly ownerId: string;
  readonly triggerId: string | null;
  readonly origin: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly tainted: boolean;
  readonly gated: boolean;
  readonly policy: TaskPolicySnapshot;
  readonly title: string;
  readonly detail: string | null;
  readonly retryOf: string | null;
  readonly retryOnInterrupt: boolean;
  readonly maxRunMs: number;
  readonly maxRunUsd: number | null;
  readonly at: number;
}

export interface Move {
  readonly reason?: string | null;
  readonly sessionId?: string;
  readonly startedAt?: number;
  /** Set for a terminal state, left alone otherwise. */
  readonly endedAt?: number;
}

const TERMINAL: readonly string[] = TASK_TERMINAL_STATES;
export const isTerminal = (state: TaskState): boolean => TERMINAL.includes(state);

const JOINED = `SELECT t.*, g.name AS trigger_name, g.project_id AS project_id
  FROM tasks t LEFT JOIN triggers g ON g.id = t.trigger_id`;

/** The only writer of `tasks` (C §3.2). Every state change is one `UPDATE … WHERE state IN (…)` whose `changes` is read. */
export function createTaskStore(db: Db) {
  return {
    insert(task: NewTask): void {
      db.run(
        `INSERT INTO tasks (id, owner_id, trigger_id, origin, state, cwd, prompt, tainted, gated, policy, title, detail,
           retry_of, retry_on_interrupt, max_run_ms, max_run_usd, created_at)
         VALUES ($id, $ownerId, $triggerId, $origin, 'queued', $cwd, $prompt, $tainted, $gated, $policy, $title, $detail,
           $retryOf, $retryOnInterrupt, $maxRunMs, $maxRunUsd, $at)`,
        {
          id: task.id,
          ownerId: task.ownerId,
          triggerId: task.triggerId,
          origin: task.origin,
          cwd: task.cwd,
          prompt: task.prompt,
          tainted: task.tainted ? 1 : 0,
          gated: task.gated ? 1 : 0,
          policy: JSON.stringify(task.policy),
          title: task.title,
          detail: task.detail,
          retryOf: task.retryOf,
          retryOnInterrupt: task.retryOnInterrupt ? 1 : 0,
          maxRunMs: task.maxRunMs,
          maxRunUsd: task.maxRunUsd,
          at: task.at,
        },
      );
    },

    get: (id: string): TaskJoined | undefined => db.get<TaskJoined>(`${JOINED} WHERE t.id = $id`, { id }),

    /** Another owner's task is as good as absent. */
    getOwned: (ownerId: string, id: string): TaskJoined | undefined =>
      db.get<TaskJoined>(`${JOINED} WHERE t.id = $id AND t.owner_id = $ownerId`, { id, ownerId }),

    bySession: (sessionId: string): TaskJoined | undefined =>
      db.get<TaskJoined>(`${JOINED} WHERE t.session_id = $sessionId`, { sessionId }),

    /** Moves the task when it is in one of `from`: true when this call changed the row (M10R35). */
    move(id: string, from: readonly TaskState[], to: TaskState, change: Move = {}): boolean {
      return (
        db.run(
          `UPDATE tasks SET state = $to, reason = $reason, session_id = COALESCE($sessionId, session_id),
             started_at = COALESCE($startedAt, started_at), ended_at = COALESCE($endedAt, ended_at)
           WHERE id = $id AND state IN (SELECT value FROM json_each($from))`,
          {
            id,
            to,
            from: JSON.stringify(from),
            reason: change.reason ?? null,
            sessionId: change.sessionId ?? null,
            startedAt: change.startedAt ?? null,
            endedAt: change.endedAt ?? null,
          },
        ).changes === 1
      );
    },

    queuedOfTrigger: (triggerId: string): number =>
      db.get<{ n: number }>(
        "SELECT count(*) AS n FROM tasks WHERE trigger_id = $triggerId AND state = 'queued'",
        {
          triggerId,
        },
      )?.n ?? 0,

    /** The ids of a trigger's tasks that are open or ended since `since`: what the trigger's own budget adds up (M10R66). */
    idsOfTriggerSince: (triggerId: string, since: number): string[] =>
      db
        .all<{ id: string }>(
          "SELECT id FROM tasks WHERE trigger_id = $triggerId AND (ended_at IS NULL OR ended_at >= $since)",
          { triggerId, since },
        )
        .map((row) => row.id),

    /** Running tasks hold a slot; limited ones wait for a quota and hold none. */
    counts(ownerId: string): { running: number; queued: number } {
      const rows = db.all<{ state: string; n: number }>(
        `SELECT state, count(*) AS n FROM tasks WHERE owner_id = $ownerId AND state IN ('running', 'queued') GROUP BY state`,
        { ownerId },
      );
      const of = (state: string) => rows.find((row) => row.state === state)?.n ?? 0;
      return { running: of("running"), queued: of("queued") };
    },

    queuedOwners: (): string[] =>
      db
        .all<{ owner_id: string }>(
          "SELECT DISTINCT owner_id FROM tasks WHERE state = 'queued' ORDER BY owner_id",
        )
        .map((row) => row.owner_id),

    /**
     * The next task to start across `owners` (M10R36): among their queued tasks not in `excluded`, the trigger whose
     * last start is the oldest (never started first; the tasks of deleted triggers are one group, started when its last
     * task did), then the oldest task of that trigger. One order for everybody: no owner goes first by name.
     */
    nextQueued(owners: readonly string[], excluded: readonly string[]): TaskRow | undefined {
      return db.get<TaskRow>(
        `SELECT t.* FROM tasks t LEFT JOIN triggers g ON g.id = t.trigger_id
         WHERE t.owner_id IN (SELECT value FROM json_each($owners)) AND t.state = 'queued'
           AND t.id NOT IN (SELECT value FROM json_each($excluded))
         ORDER BY CASE WHEN t.trigger_id IS NULL
             THEN COALESCE((SELECT max(s.started_at) FROM tasks s WHERE s.trigger_id IS NULL AND s.owner_id = t.owner_id), -1)
             ELSE COALESCE(g.last_start_at, -1) END,
           t.created_at, t.id
         LIMIT 1`,
        { owners: JSON.stringify(owners), excluded: JSON.stringify(excluded) },
      );
    },

    queuedIds: (ownerId: string, limit: number): string[] =>
      db
        .all<{ id: string }>(
          "SELECT id FROM tasks WHERE owner_id = $ownerId AND state = 'queued' ORDER BY created_at DESC, id DESC LIMIT $limit",
          { ownerId, limit },
        )
        .map((row) => row.id),

    running: (): TaskRow[] =>
      db.all<TaskRow>("SELECT * FROM tasks WHERE state = 'running' ORDER BY created_at, id"),

    /** The running tasks of an owner that the daily budget gates (M10R39): a browser's manual fire is not among them. */
    runningGated: (ownerId: string): TaskRow[] =>
      db.all<TaskRow>(
        "SELECT * FROM tasks WHERE owner_id = $ownerId AND state = 'running' AND gated = 1 ORDER BY created_at, id",
        { ownerId },
      ),

    /** Housekeeping (M10R44): the done tasks with a session that ended before `before`, oldest first. */
    doneWithSessionBefore: (before: number, limit: number): TaskRow[] =>
      db.all<TaskRow>(
        `SELECT * FROM tasks WHERE state = 'done' AND session_id IS NOT NULL AND ended_at < $before
         ORDER BY ended_at, id LIMIT $limit`,
        { before, limit },
      ),

    remove: (id: string): void => void db.run("DELETE FROM tasks WHERE id = $id", { id }),

    /** Terminal tasks older than `before` that leave no session behind to find again: done ones with a session are the pass's own. */
    removeEndedBefore: (before: number): number =>
      db.run(`DELETE FROM tasks WHERE ended_at < $before AND (state != 'done' OR session_id IS NULL)`, {
        before,
      }).changes,

    /** The board's rows (M10R43): every live task, and the finished ones of the window, newest first. */
    board(ownerId: string, since: number, limit: number): TaskJoined[] {
      return db.all<TaskJoined>(
        `${JOINED} WHERE t.owner_id = $ownerId AND (t.state IN ('queued', 'running', 'limited') OR t.ended_at >= $since)
         ORDER BY t.created_at DESC, t.id DESC LIMIT $limit`,
        { ownerId, since, limit },
      );
    },
  };
}
export type TaskStore = ReturnType<typeof createTaskStore>;
