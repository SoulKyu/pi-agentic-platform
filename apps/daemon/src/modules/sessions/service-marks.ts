import { applyMark, type Caller, type MarkChange, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import type { MarksStore } from "./marks-store.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionRow } from "./store.ts";

/** Sessions whose rank differs between the two orders (absent counts as a rank). */
const moved = (before: readonly string[], after: readonly string[] | null): string[] =>
  after === null
    ? []
    : [...new Set([...before, ...after])].filter((id) => before.indexOf(id) !== after.indexOf(id));

export function createSessionMarks(deps: {
  readonly store: MarksStore;
  readonly clock: Clock;
  owned(sessionId: string, caller: Caller): SessionRow;
  readonly publisher: ShellPublisher;
  onSnoozeChange(): void;
}) {
  return {
    /** Synchronous on purpose: the state changes before the caller's first `await` (M4R126). */
    mark(input: { readonly sessionId: string; readonly change: MarkChange }, caller: Caller): void {
      const row = deps.owned(input.sessionId, caller);
      const current = deps.store.row(row.id);
      if (!current) throw new PapError("not_found");
      const pins = deps.store.pins(row.ownerId);
      const outcome = applyMark(row.id, current.marks, input.change, pins, deps.clock.now());
      if (!outcome.ok) throw new PapError(outcome.code);
      try {
        deps.store.write(
          row.id,
          outcome.marks,
          outcome.pins ? { ownerId: row.ownerId, order: outcome.pins } : null,
        );
      } catch (error) {
        // A database a newer pap wrote refuses the write: a typed error, not SQLite's message.
        throw isReadOnlyError(error) ? new PapError("read_only") : error;
      }
      deps.publisher.changed(row.id);
      for (const id of moved(pins, outcome.pins)) deps.publisher.changed(id);
      if ((current.marks.archivedAt === null) !== (outcome.marks.archivedAt === null)) {
        deps.publisher.countsChanged(row.ownerId);
        deps.publisher.projectChanged(row.ownerId, current.projectId);
      }
      if (current.marks.snoozedUntil !== outcome.marks.snoozedUntil) deps.onSnoozeChange();
    },
  };
}
