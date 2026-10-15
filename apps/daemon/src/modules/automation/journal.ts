import { type FireVerdict, type FireView, JOURNAL_PAGE, PapError, type TaskState } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";
import type { RunsPort } from "../runs/index.ts";
import type { TriggerRecord } from "./triggers.ts";

export interface JournalDeps {
  readonly db: Db;
  readonly triggers: { get(ownerId: string, id: string): TriggerRecord | null };
  readonly runs: Pick<RunsPort, "sessionCost">;
}

interface Raw {
  id: number;
  first_at: number;
  last_at: number;
  count: number;
  source: string;
  verdict: FireVerdict;
  detail: string | null;
  task_id: string | null;
  task_state: TaskState | null;
  session_id: string | null;
  started_at: number | null;
  ended_at: number | null;
}

/**
 * `automation.journal` (M10R65): a trigger's fire lines, newest first, 50 at a time. Repeated refusals were counted into
 * one line when they were written (`writeJournal`); a `fired` line has its task, joined here with the task's state, its
 * duration and its cost (the session's runs, an open one included). A task the 30-day rule removed leaves the line alone.
 */
export function createJournal(deps: JournalDeps) {
  return {
    page(
      ownerId: string,
      triggerId: string,
      before: number | undefined,
    ): { entries: FireView[]; hasMore: boolean } {
      if (deps.triggers.get(ownerId, triggerId) === null) throw new PapError("not_found");
      const rows = deps.db.all<Raw>(
        `SELECT f.id, f.first_at, f.last_at, f.count, f.source, f.verdict, f.detail, f.task_id,
                t.state AS task_state, t.session_id, t.started_at, t.ended_at
         FROM trigger_fires f LEFT JOIN tasks t ON t.id = f.task_id
         WHERE f.trigger_id = $triggerId AND f.owner_id = $ownerId AND ($before IS NULL OR f.id < $before)
         ORDER BY f.id DESC LIMIT $limit`,
        { triggerId, ownerId, before: before ?? null, limit: JOURNAL_PAGE + 1 },
      );
      const entries = rows.slice(0, JOURNAL_PAGE).map((row): FireView => ({
        id: row.id,
        firstAt: row.first_at,
        at: row.last_at,
        count: row.count,
        source: row.source,
        verdict: row.verdict,
        detail: row.detail,
        taskId: row.task_id,
        taskState: row.task_state,
        durationMs:
          row.started_at !== null && row.ended_at !== null
            ? Math.max(0, row.ended_at - row.started_at)
            : null,
        costUsd: row.session_id === null ? null : deps.runs.sessionCost(row.session_id),
      }));
      return { entries, hasMore: rows.length > JOURNAL_PAGE };
    },
  };
}
export type Journal = ReturnType<typeof createJournal>;
