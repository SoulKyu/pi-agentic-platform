import type { ReviewComment, ReviewDoc, ReviewScope } from "@pap/contracts";
import type { ReviewFile } from "./review-types.ts";
import { Banner, Button, EmptyState, Icon, IconBack, Spinner, useIsPhone } from "@pap/ui";
import { useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import "./register-review-catalog.ts";
import { formatReviewBatch } from "./review-batch.ts";
import { ReviewFileDiff } from "./ReviewFileDiff.tsx";
import { ReviewFiles } from "./ReviewFiles.tsx";
import { markSent, orderFiles, readyToSend, setSeen } from "./review.vm.ts";
import { ScopeBar, type ScopeChoice } from "./ScopeBar.tsx";
import { SendBar } from "./SendBar.tsx";
import { useReviewList, useReviewTurns } from "./use-review-data.ts";
import { useReviewState } from "./use-review-state.ts";

interface ReviewPaneProps {
  readonly laneId: string;
  readonly worktree: string;
  /** The session the chat shows: the turns are its, and "Send to" goes to its composer. */
  readonly sessionId: string | null;
  readonly sessionLabel: string;
  /** Shows a file in the Files pane; the shell gives it (features never import each other). */
  onOpenFile(absolutePath: string): void;
  /** Brings the lane's chat to the front on that session. */
  onOpenChat(sessionId: string): void;
}

/**
 * The batch goes to the composer of `target`, or of a session started for it. The comments are marked sent first: if
 * that fails nothing was put in the composer and they stay unsent. Null when it did not happen.
 */
async function deliverBatch(
  laneId: string,
  target: string | null,
  ready: readonly ReviewComment[],
  update: (mutate: (doc: ReviewDoc) => ReviewDoc) => Promise<boolean>,
): Promise<string | null> {
  const { rpc } = getRuntime();
  const sessionId =
    target ?? (await rpc.call("lanes.newSession", { laneId }, { commandId: rpc.newCommandId() })).sessionId;
  const ids = ready.map((comment) => comment.id);
  if (!(await update((doc) => markSent(doc, ids, Date.now())))) return null;
  useComposerPrefill.getState().push(sessionId, formatReviewBatch(ready));
  return sessionId;
}

/** The lane's review (M9R88): scope, files with their Seen state, the diff with comments, and the send bar. */
export function ReviewPane({
  laneId,
  worktree,
  sessionId,
  sessionLabel,
  onOpenFile,
  onOpenChat,
}: ReviewPaneProps) {
  const t = useT();
  const phone = useIsPhone();
  const [scope, setScope] = useState<ScopeChoice>({ kind: "branch" });
  const [attempt, setAttempt] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const review = useReviewState(laneId);
  const turns = useReviewTurns(laneId, sessionId, scope.kind === "turn");

  // Turn with none picked yet: the newest turn.
  const turnEntry =
    scope.kind === "turn"
      ? (scope.userEntryId ?? (turns.phase === "ready" ? (turns.value[0]?.userEntryId ?? null) : null))
      : null;
  const shownScope: ScopeChoice = scope.kind === "turn" ? { kind: "turn", userEntryId: turnEntry } : scope;
  const asked: ReviewScope | null =
    scope.kind === "branch"
      ? { kind: "branch" }
      : turnEntry !== null && sessionId !== null
        ? { kind: "turn", sessionId, userEntryId: turnEntry }
        : null;
  const list = useReviewList(laneId, asked, attempt);

  const ready = readyToSend(review.doc);
  const sendTo = async (target: string | null) => {
    if (sending || ready.length === 0) return;
    setSending(true);
    setSendFailed(false);
    const delivered = await deliverBatch(laneId, target, ready, review.update).catch(() => null);
    setSending(false);
    if (delivered === null) setSendFailed(true);
    else onOpenChat(delivered);
  };

  const toggleSeen = (file: ReviewFile, seen: boolean) =>
    void review.update((doc) => setSeen(doc, file, seen));

  let body;
  if (list.phase === "loading") {
    body = (
      <div className="flex items-center gap-s2 p-s3 text-ui text-muted">
        <Spinner label={t("lanes.review.loading")} />
      </div>
    );
  } else if (list.phase === "error") {
    body = (
      <div className="p-s3">
        <Banner
          tone="capacity"
          title={t("lanes.review.failed")}
          actions={
            <Button variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
              {t("lanes.review.retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (list.value.files.length === 0) {
    body = (
      <div className="p-s3">
        <EmptyState title={t("lanes.review.empty.title")} purpose={t("lanes.review.empty.purpose")} />
      </div>
    );
  } else {
    const files = orderFiles(list.value.files);
    const selected = files.find((file) => file.path === selectedPath) ?? null;
    const listShown = !phone || showList;
    const diffShown = !phone || !showList;
    body = (
      <div className="flex min-h-0 flex-1">
        {listShown ? (
          <div
            className={
              diffShown
                ? "flex min-h-0 w-explorer shrink-0 flex-col overflow-y-auto border-r border-border"
                : "flex min-h-0 flex-1 flex-col overflow-y-auto"
            }
          >
            <ReviewFiles
              files={files}
              doc={review.doc}
              selected={selected?.path ?? null}
              truncated={list.value.truncated}
              onSelect={(path) => {
                setSelectedPath(path);
                setShowList(false);
              }}
              onSeen={toggleSeen}
            />
          </div>
        ) : null}
        {diffShown ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {listShown ? null : (
              <div className="border-b border-border px-s2 py-s1">
                <Button variant="ghost" size="sm" onClick={() => setShowList(true)}>
                  <Icon icon={IconBack} size={14} />
                  {t("lanes.review.diff.back")}
                </Button>
              </div>
            )}
            {selected === null ? (
              <p className="p-s3 text-ui text-muted">{t("lanes.review.diff.pick")}</p>
            ) : (
              <ReviewFileDiff
                key={selected.path}
                worktree={worktree}
                list={list.value}
                file={selected}
                doc={review.doc}
                update={review.update}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        ) : null}
      </div>
    );
  }

  const problem =
    review.error === null
      ? null
      : review.error === "conflict"
        ? t("lanes.review.save.conflict")
        : review.status === "error"
          ? t(errorKey(review.error))
          : t("lanes.review.save.failed");
  return (
    <div data-review-pane={laneId} className="flex min-h-0 flex-1 flex-col">
      <ScopeBar
        scope={shownScope}
        turns={turns}
        hasSession={sessionId !== null}
        onScope={(next) => {
          setScope(next);
          setSelectedPath(null);
          setShowList(true);
        }}
        onRefresh={() => {
          setAttempt((count) => count + 1);
          review.reload();
        }}
      />
      {problem === null ? null : (
        <p role="alert" className="px-s3 py-s1 text-ui text-attn">
          {problem}
        </p>
      )}
      {body}
      <SendBar
        ready={ready.length}
        sessionLabel={sessionId === null ? null : escapeHidden(sessionLabel)}
        busy={sending}
        problem={sendFailed}
        onSend={() => void sendTo(sessionId)}
        onNewSession={() => void sendTo(null)}
      />
    </div>
  );
}
