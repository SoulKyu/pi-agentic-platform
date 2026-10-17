import { AuthorGroup, Button, type ToolDetail } from "@pap/ui";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import type { Interleave } from "../../stores/thread-interleave.ts";
import { useFocusEntry } from "../../stores/focus-entry.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { failureText } from "./failure.ts";
import { MessageRow, SummaryRow, type RowActions } from "./MessageRow.tsx";
import { Minimap } from "./Minimap.tsx";
import { rowId } from "./minimap.vm.ts";
import { ToolItemCard } from "./ToolItemCard.tsx";
import { groupItems, interleaveRow } from "./transcript-groups.ts";
import { transcriptItems, type TranscriptItem } from "./transcript.vm.ts";
import type { Track } from "./use-action.ts";
import { useBranches } from "./use-branches.ts";
import { useStickToBottom } from "./use-stick-to-bottom.ts";

interface TranscriptProps {
  readonly sessionId: string;
  readonly view: SessionView;
  /** The account's tool card detail; compact until the shell says otherwise. */
  readonly toolDetail?: ToolDetail;
  /** Row actions ("Fork from here", "Edit from here"): absent where a transcript is only read. */
  readonly rowActions?: {
    readonly track: Track;
    readonly busy: boolean;
    readonly onEdit: (text: string) => void;
    readonly announce?: RowActions["announce"];
  };
  /** An agent's thread: its event cards and day separators are placed among the rows (M11R118). */
  readonly interleave?: Interleave;
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
      prepend(sessionId, page, { generation, oldestEntryId: before }, latest.current.preserve());
    } catch (failure) {
      setError(failureText(failure));
    }
    inFlight.current = false;
    setLoading(false);
  };
  return { load, loading, error };
}

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;
type HistoryPage = Parameters<SessionStoreState["prependHistory"]>[1];

/** Prepends a fetched page and releases the scroll anchor when the page left nothing to keep in place. */
function prepend(
  sessionId: string,
  page: HistoryPage,
  guard: Parameters<SessionStoreState["prependHistory"]>[2],
  release: () => void,
): void {
  const was = useSessionStore.getState().views[sessionId];
  useSessionStore.getState().prependHistory(sessionId, page, guard);
  const now = useSessionStore.getState().views[sessionId];
  // A page the store dropped (another view), or one that added no row and moved no cursor, leaves nothing to keep in place.
  const unchanged =
    now === was ||
    (now?.messages.length === was?.messages.length &&
      now?.history.oldestEntryId === was?.history.oldestEntryId);
  if (unchanged) release();
}

/**
 * Acts on the entry a search hit asked for once this session's rows are loaded (M4R108): scrolls to its row, focuses
 * it and takes the request. While the entry is not among the rows but "Load older messages" exists, the request stays
 * (loading satisfies it) and the hook returns the older-messages notice. When nothing can load, the request is taken
 * at once and the "not shown" notice lives in this mount only, so no later visit sees it again.
 */
function useFocusMatch(
  sessionId: string,
  view: SessionView,
  items: readonly TranscriptItem[],
  scope: string,
  canLoad: boolean,
): "search.olderMatch" | "search.notShown" | null {
  const asked = useFocusEntry((state) =>
    state.target?.sessionId === sessionId ? state.target.entryId : null,
  );
  const [notShown, setNotShown] = useState(false);
  const item = asked === null ? undefined : items.find((row) => "entryId" in row && row.entryId === asked);
  const itemKey = item?.key;
  const unshowable = asked !== null && view.loaded && itemKey === undefined && !canLoad;
  // Derived during render (the request is gone from the store by the next one): this mount remembers it.
  if (unshowable !== notShown && (unshowable || itemKey !== undefined)) setNotShown(unshowable);
  useEffect(() => {
    if (unshowable) useFocusEntry.getState().take(sessionId);
    if (itemKey === undefined || !view.loaded) return;
    const element = document.getElementById(rowId(scope, itemKey));
    if (element === null || useFocusEntry.getState().take(sessionId) === null) return;
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center" });
  }, [unshowable, itemKey, scope, sessionId, view.loaded]);
  if (notShown) return "search.notShown";
  return asked !== null && view.loaded && itemKey === undefined ? "search.olderMatch" : null;
}

export function Transcript({ sessionId, view, toolDetail, rowActions, interleave }: TranscriptProps) {
  const t = useT();
  const items = transcriptItems(view, t);
  const plan = interleave?.arrange(items.map(interleaveRow), view.history.hasMore);
  const shown = plan ? items.filter((item) => !plan.hidden.has(item.key)) : items;
  const groups = groupItems(shown, plan?.breaks);
  const scope = useId();
  const last = items.at(-1);
  const { attach, onScroll, preserveOnPrepend } = useStickToBottom(
    `${items.length}:${last && "text" in last ? last.text.length : 0}:${view.history.oldestEntryId}:${plan?.after.length ?? 0}`,
  );
  const older = useOlderHistory(sessionId, view, preserveOnPrepend);
  const branches = useBranches(sessionId, view, rowActions !== undefined);
  const canLoad = view.history.hasMore && view.history.oldestEntryId !== null;
  const sentinel = useRef<HTMLLIElement | null>(null);
  const loadRef = useRef(older.load);
  useLayoutEffect(() => {
    loadRef.current = older.load;
  });
  const quiet = older.error !== null;
  const matchNotice = useFocusMatch(sessionId, view, items, scope, canLoad);
  const actionsFor = (item: TranscriptItem): RowActions | undefined =>
    rowActions && item.kind === "message"
      ? {
          sessionId,
          track: rowActions.track,
          onEdit: rowActions.onEdit,
          announce: rowActions.announce,
          branches: branches.points,
          blocked: rowActions.busy || view.status === "running" || view.activity.compacting,
        }
      : undefined;

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
      <div className="flex min-h-0 flex-1 gap-s2">
        <ol
          ref={attach}
          onScroll={onScroll}
          aria-label={t("sessions.transcript.label")}
          className="flex min-w-0 flex-1 flex-col gap-s3 overflow-y-auto"
        >
          {canLoad ? (
            <li ref={sentinel} className="flex flex-col items-center gap-s1">
              {older.error ? (
                <p role="alert" className="text-ui text-attn">
                  {older.error}
                </p>
              ) : null}
              <Button disabled={older.loading} onClick={() => void older.load()}>
                {t("sessions.transcript.loadOlder")}
              </Button>
            </li>
          ) : null}
          {groups.map((group) => (
            <Fragment key={group.key}>
              {plan?.before.get(group.key)?.map((node, n) => (
                <li key={`extra:${n}`} className="mx-auto w-full max-w-chat">
                  {node}
                </li>
              ))}
              <li className="mx-auto w-full max-w-chat">
                {group.kind === "run" ? (
                  <AuthorGroup author={group.author} name={t(`author.${group.author}`)}>
                    {group.items.map((item) => (
                      <div key={item.key} id={rowId(scope, item.key)}>
                        {item.kind === "tool" ? (
                          <ToolItemCard item={item} sessionId={sessionId} detail={toolDetail ?? "compact"} />
                        ) : (
                          <MessageRow item={item} grouped actions={actionsFor(item)} />
                        )}
                      </div>
                    ))}
                  </AuthorGroup>
                ) : (
                  <div id={rowId(scope, group.item.key)}>
                    {group.item.kind === "summary" ? (
                      <SummaryRow item={group.item} />
                    ) : group.item.kind === "failure" ? (
                      <div
                        data-failure
                        role={group.item === items.at(-1) ? "alert" : undefined}
                        className="border-l-2 border-err px-s3 py-s2 text-ui text-err"
                      >
                        <p className="label-hud">{t("session.failure")}</p>
                        <p className="mt-s1 whitespace-pre-wrap break-words">{group.item.text}</p>
                      </div>
                    ) : group.item.kind === "message" ? (
                      <MessageRow item={group.item} actions={actionsFor(group.item)} />
                    ) : null}
                  </div>
                )}
              </li>
            </Fragment>
          ))}
          {plan?.after.map((node, n) => (
            <li key={`after:${n}`} className="mx-auto w-full max-w-chat">
              {node}
            </li>
          ))}
        </ol>
        <Minimap scope={scope} items={shown} view={view} onLoadOlder={() => void older.load()} />
      </div>
      {branches.error ? (
        <p role="alert" className="text-ui text-attn">
          {branches.error}
        </p>
      ) : null}
      {matchNotice ? (
        <p role="status" className="text-ui text-muted">
          {t(matchNotice)}
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
