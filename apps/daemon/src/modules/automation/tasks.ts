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
  /** M11: the agent a task runs as and where (`isolated` or `thread`); both null for a project task. */
  readonly agent_id: string | null;
  readonly target: "isolated" | "thread" | null;
  readonly requested_by: string | null;
  readonly not_before: number | null;
  /** The session that set a reminder (W5-R44). */
  readonly set_by_session: string | null;
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
  /** An agent's task (M11R64): both or neither. */
  readonly agentId?: string | null;
  readonly target?: "isolated" | "thread" | null;
  /** The agent whose delegation started this task, or whose delegated run set this reminder (M11R78, M11R80). */
  readonly requestedBy?: string | null;
  /** A reminder: not started before this instant (M11R81). */
  readonly notBefore?: number | null;
  /** The session that set a reminder: a tainted one may fire only into it (W5-R44). */
  readonly setBySession?: string | null;
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
           retry_of, retry_on_interrupt, max_run_ms, max_run_usd, created_at, agent_id, target, requested_by, not_before, set_by_session)
         VALUES ($id, $ownerId, $triggerId, $origin, 'queued', $cwd, $prompt, $tainted, $gated, $policy, $title, $detail,
           $retryOf, $retryOnInterrupt, $maxRunMs, $maxRunUsd, $at, $agentId, $target, $requestedBy, $notBefore, $setBySession)`,
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
          agentId: task.agentId ?? null,
          target: task.target ?? null,
          requestedBy: task.requestedBy ?? null,
          notBefore: task.notBefore ?? null,
          setBySession: task.setBySession ?? null,
        },
      );
    },

    get: (id: string): TaskJoined | undefined => db.get<TaskJoined>(`${JOINED} WHERE t.id = $id`, { id }),

    /** Another owner's task is as good as absent. */
    getOwned: (ownerId: string, id: string): TaskJoined | undefined =>
      db.get<TaskJoined>(`${JOINED} WHERE t.id = $id AND t.owner_id = $ownerId`, { id, ownerId }),

    /** The task of a session; an agent's thread serves many tasks one after the other, so the live one comes first. */
    bySession: (sessionId: string): TaskJoined | undefined =>
      db.get<TaskJoined>(
        `${JOINED} WHERE t.session_id = $sessionId
         ORDER BY CASE WHEN t.state IN ('running', 'limited') THEN 0 ELSE 1 END, t.created_at DESC, t.id DESC LIMIT 1`,
        { sessionId },
      ),

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
    nextQueued(owners: readonly string[], excluded: readonly string[], now: number): TaskRow | undefined {
      return db.get<TaskRow>(
        `SELECT t.* FROM tasks t LEFT JOIN triggers g ON g.id = t.trigger_id
         WHERE t.owner_id IN (SELECT value FROM json_each($owners)) AND t.state = 'queued'
           AND t.id NOT IN (SELECT value FROM json_each($excluded))
           AND (t.not_before IS NULL OR t.not_before <= $now)
         ORDER BY CASE WHEN t.trigger_id IS NULL
             THEN COALESCE((SELECT max(s.started_at) FROM tasks s WHERE s.trigger_id IS NULL AND s.owner_id = t.owner_id), -1)
             ELSE COALESCE(g.last_start_at, -1) END,
           t.created_at, t.id
         LIMIT 1`,
        { owners: JSON.stringify(owners), excluded: JSON.stringify(excluded), now },
      );
    },

    /** Queued tasks whose `not_before` has come (M11R81): what the due timer hands to the runner. */
    dueQueued: (now: number, limit: number): TaskRow[] =>
      db.all<TaskRow>(
        "SELECT * FROM tasks WHERE state = 'queued' AND not_before IS NOT NULL AND not_before <= $now ORDER BY not_before, id LIMIT $limit",
        { now, limit },
      ),

    /** The earliest `not_before` still ahead among queued tasks; null when none waits for a time. */
    nextNotBefore: (now: number): number | null =>
      db.get<{ at: number | null }>(
        "SELECT min(not_before) AS at FROM tasks WHERE state = 'queued' AND not_before > $now",
        { now },
      )?.at ?? null,

    /** The requester of the agent's running thread task (null: none runs, or it was not delegated): the depth of M11R78. */
    runningRequester: (ownerId: string, agentId: string): string | null =>
      db.get<{ requested_by: string | null }>(
        `SELECT requested_by FROM tasks WHERE owner_id = $ownerId AND agent_id = $agentId AND target = 'thread'
           AND state = 'running' ORDER BY started_at DESC, id DESC LIMIT 1`,
        { ownerId, agentId },
      )?.requested_by ?? null,

    /** Delegations `requestedBy` asked for since `since`, whatever became of them (the rolling hour of M11R78). */
    delegationsSince: (ownerId: string, requestedBy: string, since: number): number =>
      db.get<{ n: number }>(
        `SELECT count(*) AS n FROM tasks WHERE owner_id = $ownerId AND origin = 'delegate' AND requested_by = $requestedBy
           AND created_at >= $since`,
        { ownerId, requestedBy, since },
      )?.n ?? 0,

    /** Delegations still queued for `agentId`, from any requester (the per-target cap of T12). */
    queuedDelegationsTo: (ownerId: string, agentId: string): number =>
      db.get<{ n: number }>(
        `SELECT count(*) AS n FROM tasks WHERE owner_id = $ownerId AND agent_id = $agentId AND origin = 'delegate'
           AND state = 'queued'`,
        { ownerId, agentId },
      )?.n ?? 0,

    /** The agent's reminders: still queued, and made since `since` (M11R80). */
    reminders: (ownerId: string, agentId: string, since: number): { pending: number; created: number } =>
      db.get<{ pending: number; created: number }>(
        `SELECT count(*) FILTER (WHERE state = 'queued') AS pending, count(*) FILTER (WHERE created_at >= $since) AS created
         FROM tasks WHERE owner_id = $ownerId AND agent_id = $agentId AND origin = 'remind'`,
        { ownerId, agentId, since },
      ) ?? { pending: 0, created: 0 },

    queuedIds: (ownerId: string, limit: number): string[] =>
      db
        .all<{ id: string }>(
          "SELECT id FROM tasks WHERE owner_id = $ownerId AND state = 'queued' ORDER BY created_at DESC, id DESC LIMIT $limit",
          { ownerId, limit },
        )
        .map((row) => row.id),

    /** An agent's tasks in these states (M11): what its delete waits for and cancels. */
    ofAgent: (ownerId: string, agentId: string, states: readonly TaskState[]): TaskRow[] =>
      db.all<TaskRow>(
        `SELECT * FROM tasks WHERE owner_id = $ownerId AND agent_id = $agentId
           AND state IN (SELECT value FROM json_each($states)) ORDER BY created_at, id`,
        { ownerId, agentId, states: JSON.stringify(states) },
      ),

    /** The delegations an agent asked for, in these states (quarantine ends the queued ones, W5-R64 I4). */
    requestedBy: (ownerId: string, agentId: string, states: readonly TaskState[]): TaskRow[] =>
      db.all<TaskRow>(
        `SELECT * FROM tasks WHERE owner_id = $ownerId AND requested_by = $agentId AND origin = 'delegate'
           AND state IN (SELECT value FROM json_each($states)) ORDER BY created_at, id`,
        { ownerId, agentId, states: JSON.stringify(states) },
      ),

    /** The newest tasks of an agent, any state, newest first (the status panel, M11R76). */
    newestOfAgent: (ownerId: string, agentId: string, limit: number): TaskJoined[] =>
      db.all<TaskJoined>(
        `${JOINED} WHERE t.owner_id = $ownerId AND t.agent_id = $agentId ORDER BY t.created_at DESC, t.id DESC LIMIT $limit`,
        { ownerId, agentId, limit },
      ),

    /** The newest finished thread tasks, any owner (their cards are settled at boot, M11R71). */
    endedThreadTasks: (limit: number): TaskRow[] =>
      db.all<TaskRow>(
        `SELECT * FROM tasks WHERE target = 'thread' AND ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC LIMIT $limit`,
        { limit },
      ),

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
           AND (target IS NULL OR target <> 'thread') ORDER BY ended_at, id LIMIT $limit`,
        { before, limit },
      ),

    remove: (id: string): void => void db.run("DELETE FROM tasks WHERE id = $id", { id }),

    /** Isolated agent tasks `removeEndedBefore` is about to delete: their scratch folders go with them (M11R180). */
    isolatedEndedBefore: (before: number, limit: number): TaskRow[] =>
      db.all<TaskRow>(
        `SELECT * FROM tasks WHERE ended_at < $before AND (state != 'done' OR session_id IS NULL)
           AND agent_id IS NOT NULL AND target = 'isolated' ORDER BY ended_at, id LIMIT $limit`,
        { before, limit },
      ),

    exists: (id: string): boolean => db.get("SELECT 1 AS n FROM tasks WHERE id = $id", { id }) !== undefined,

    /**
     * Terminal tasks older than `before` that leave no session behind to find again: done ones with a session are the
     * pass's own. A thread task's session is the agent's thread, which is never the pass's to delete: its row goes alone.
     */
    removeEndedBefore: (before: number): number =>
      db.run(
        `DELETE FROM tasks WHERE ended_at < $before AND (state != 'done' OR session_id IS NULL OR target = 'thread')`,
        { before },
      ).changes,

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
