import { PRECHECK_REMOVED } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { writeJournal } from "./fire-journal.ts";
import type { TriggerRecord } from "./triggers.ts";

/**
 * Prechecks were removed (B6): a stored trigger that holds one never fires, from any source (a webhook and a task retry too). The refusal is journaled here (the journal
 * collapses repeats, so a scheduled tick records one line per distinct cause) and nothing is ever spawned.
 */
export function refuseStoredPrecheck(
  deps: { readonly db: Db; readonly clock: Clock },
  record: TriggerRecord,
  source: "schedule" | "manual" | "feed" | "webhook" | "retry",
): boolean {
  if (record.input?.execution.precheck == null) return false;
  deps.db.transaction(() =>
    writeJournal(deps.db, {
      triggerId: record.id,
      ownerId: record.ownerId,
      source,
      verdict: "error",
      detail: PRECHECK_REMOVED,
      taskId: null,
      dedupKey: null,
      at: deps.clock.now(),
    }),
  );
  return true;
}
