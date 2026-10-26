import type { Db } from "../../kernel/db/database.ts";
import type { TaskStore } from "./tasks.ts";

/**
 * One run at a time per kept trigger (K2): the queued tasks of a kept trigger while another task of it is starting, running
 * or waiting for a quota (its VM holds the disk). The admission leaves them queued: a held task is not an attempt, and the
 * other triggers' tasks go first. Reads only.
 */
export function createKeptHeld(deps: {
  readonly db: Db;
  readonly store: Pick<TaskStore, "get">;
  /** The tasks being started now, by id. */
  readonly starting: ReadonlyMap<string, string>;
}) {
  return (): string[] => {
    const triggers = [...deps.starting.keys()]
      .map((id) => deps.store.get(id)?.trigger_id ?? null)
      .filter((id): id is string => id !== null);
    return deps.db
      .all<{ id: string }>(
        `SELECT t.id FROM tasks t
         WHERE t.state = 'queued' AND t.trigger_id IS NOT NULL
           AND CASE WHEN json_valid(t.policy) THEN json_extract(t.policy, '$.keep') END = 1
           AND (t.trigger_id IN (SELECT value FROM json_each($triggers))
             OR EXISTS (SELECT 1 FROM tasks r WHERE r.trigger_id = t.trigger_id AND r.id <> t.id
                          AND r.state IN ('running', 'limited')))`,
        { triggers: JSON.stringify(triggers) },
      )
      .map((row) => row.id);
  };
}
