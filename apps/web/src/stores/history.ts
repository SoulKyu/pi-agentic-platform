import type { HistoryMeta, TranscriptRow } from "@pap/contracts";
import { toMessageView, withUniqueKey, type MessageView } from "./row-view.ts";
import type { SessionView } from "./session-reducer.ts";

/**
 * An older page goes before what the view has; a row already there (same entry id) is not added twice. A page asked
 * for another view (a snapshot replaced it meanwhile, or another page moved the cursor) is dropped (M2-RT-12).
 */
export function prependHistory(
  view: SessionView,
  page: HistoryMeta & { rows: readonly TranscriptRow[] },
  asked: { readonly generation: number; readonly oldestEntryId: string | null },
): SessionView {
  if (asked.generation !== view.generation || asked.oldestEntryId !== view.history.oldestEntryId) return view;
  const known = new Set(view.messages.flatMap((message) => (message.entryId ? [message.entryId] : [])));
  const older = page.rows.flatMap((row) => {
    if (row.entryId !== null && known.has(row.entryId)) return [];
    const message = toMessageView(row.message, row.entryId);
    return message ? [message] : [];
  });
  // Keys are made again from the top, so the older rows cannot take a key a later one has.
  const messages = [...older, ...view.messages].reduce<MessageView[]>(
    (list, message) => [...list, withUniqueKey(list, message)],
    [],
  );
  return {
    ...view,
    messages,
    history: { hasMore: page.hasMore, oldestEntryId: page.oldestEntryId, turnsBefore: page.turnsBefore },
  };
}
