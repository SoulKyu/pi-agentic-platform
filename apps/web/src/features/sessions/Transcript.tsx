import { Button } from "@pap/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { failureText } from "./failure.ts";
import { MessageRow, SummaryRow } from "./MessageRow.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { transcriptItems } from "./transcript.vm.ts";
import type { Track } from "./use-action.ts";
import { useBranches } from "./use-branches.ts";
import { useStickToBottom } from "./use-stick-to-bottom.ts";

interface TranscriptProps {
  readonly sessionId: string;
  readonly view: SessionView;
  /** Row actions ("Fork from here", "Edit from here"): absent where a transcript is only read. */
  readonly rowActions?: {
    readonly track: Track;
    readonly busy: boolean;
    readonly onEdit: (text: string) => void;
  };
}

/** One page of older rows at a time, asked for the view as it is now and dropped by the store if it changed since. */
function useOlderHistory(sessionId: string, view: SessionView, preserve: () => () => void) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const latest = useRef({ view, preserve });
  useLayoutEffect(() => {
    latest.current = { view, preserve };
  });
  const load = async () => {
    const { generation, history } = latest.current.view;
    const before = history.oldestEntryId;
    if (inFlight.current || !history.hasMore || before === null) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await getRuntime().rpc.call("sessions.history", { sessionId, before });
      const release = latest.current.preserve();
      const was = useSessionStore.getState().views[sessionId];
      useSessionStore.getState().prependHistory(sessionId, page, { generation, oldestEntryId: before });
      const now = useSessionStore.getState().views[sessionId];
      // A page the store dropped (another view), or one that added no row and moved no cursor, leaves nothing to keep in place.
      if (
        now === was ||
        (now?.messages.length === was?.messages.length &&
          now?.history.oldestEntryId === was?.history.oldestEntryId)
      ) {
        release();
      }
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };
  return { load, loading, error };
}

export function Transcript({ sessionId, view, rowActions }: TranscriptProps) {
  const items = transcriptItems(view);
  const last = items.at(-1);
  const { attach, onScroll, preserveOnPrepend } = useStickToBottom(
    `${items.length}:${last && "text" in last ? last.text.length : 0}:${view.history.oldestEntryId}`,
  );
  const older = useOlderHistory(sessionId, view, preserveOnPrepend);
  const branches = useBranches(sessionId, view);
  const canLoad = view.history.hasMore && view.history.oldestEntryId !== null;
  const sentinel = useRef<HTMLLIElement | null>(null);
  const loadRef = useRef(older.load);
  useLayoutEffect(() => {
    loadRef.current = older.load;
  });
  const quiet = older.error !== null;

  // The sentinel asks while the reader is near the top; after a failure only the button asks, so it cannot loop.
  useEffect(() => {
    const target = sentinel.current;
    if (!canLoad || quiet || !target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadRef.current();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canLoad, quiet]);

  const activity = view.activity.compacting
    ? t("sessions.transcript.compacting")
    : view.activity.retry
      ? t("sessions.transcript.retrying", {
          attempt: view.activity.retry.attempt,
          max: view.activity.retry.maxAttempts,
        })
      : null;

  return (
    <>
      <ol ref={attach} onScroll={onScroll} className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {canLoad ? (
          <li ref={sentinel} className="flex flex-col items-center gap-1">
            {older.error ? (
              <p role="alert" className="text-ui text-attention">
                {older.error}
              </p>
            ) : null}
            <Button disabled={older.loading} onClick={() => void older.load()}>
              {t("sessions.transcript.loadOlder")}
            </Button>
          </li>
        ) : null}
        {items.map((item, index) => (
          <li key={item.key}>
            {item.kind === "tool" ? (
              <ToolRow item={item} sessionId={sessionId} />
            ) : item.kind === "summary" ? (
              <SummaryRow item={item} />
            ) : item.kind === "failure" ? (
              <div
                data-failure
                role={index === items.length - 1 ? "alert" : undefined}
                className="border-l-2 border-error px-3 py-2 text-ui text-error"
              >
                <p className="font-mono text-label font-semibold uppercase tracking-label">
                  {t("session.failure")}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{item.text}</p>
              </div>
            ) : (
              <MessageRow
                item={item}
                actions={
                  rowActions && {
                    sessionId,
                    track: rowActions.track,
                    onEdit: rowActions.onEdit,
                    branches: branches.points,
                    blocked: rowActions.busy || view.status === "running" || view.activity.compacting,
                  }
                }
              />
            )}
          </li>
        ))}
      </ol>
      {branches.error ? (
        <p role="alert" className="text-ui text-attention">
          {branches.error}
        </p>
      ) : null}
      {activity ? (
        <p role="status" className="text-ui text-muted">
          {activity}
        </p>
      ) : null}
    </>
  );
}
