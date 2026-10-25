import { LANE_LIMITS, type ReviewDoc, type ReviewList } from "@pap/contracts";
import type { ReviewFile } from "./review-types.ts";
import { Banner, Button, formatDiffCounts, Spinner, InlineError } from "@pap/ui";
import { languageFor, ReviewDiffView, type DiffComment } from "@pap/ui/code";
import { useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { CommentEditor } from "./CommentEditor.tsx";
import { CommentList } from "./CommentList.tsx";
import "./register-review-catalog.ts";
import { addComment, deleteComment, editComment, excerptOf, resolveComment } from "./review.vm.ts";
import { useReviewFileDiff } from "./use-review-data.ts";

interface ReviewFileDiffProps {
  readonly worktree: string;
  readonly list: ReviewList;
  readonly file: ReviewFile;
  readonly doc: ReviewDoc;
  update(mutate: (doc: ReviewDoc) => ReviewDoc): Promise<boolean>;
  onOpenFile(path: string): void;
}

type Editing =
  | { readonly kind: "new"; readonly line: number; readonly side: "after" | "before" }
  | { readonly kind: "edit"; readonly id: string };

const Note = ({ children }: { readonly children: string }) => (
  <p role="status" className="p-s3 text-ui text-muted">
    {children}
  </p>
);

/** One file of the review: its two sides in the diff, the comments drawn in it, and the list of them below. */
export function ReviewFileDiff({ worktree, list, file, doc, update, onOpenFile }: ReviewFileDiffProps) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);
  // Text typed in a new-comment editor, per line: pressing another line must not lose it (Fix round 1, I1).
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const draftKey = (target: { line: number; side: string }) => `${target.side}:${target.line}`;
  const dropDraft = (target: { line: number; side: string }) =>
    setDrafts((held) => Object.fromEntries(Object.entries(held).filter(([key]) => key !== draftKey(target))));
  const state = useReviewFileDiff(worktree, list, file, attempt);
  const language = useMemo(() => languageFor(file.path), [file.path]);
  const labels = useMemo(
    () => ({ label: t("lanes.review.diff.label"), noChanges: t("lanes.review.diff.noChanges") }),
    [t],
  );
  const mine = useMemo(() => doc.comments.filter((comment) => comment.path === file.path), [doc, file.path]);
  const editedId = editing?.kind === "edit" ? editing.id : null;
  const drawn = useMemo<DiffComment[]>(
    () =>
      mine
        .filter((comment) => comment.resolvedAt === null && comment.id !== editedId)
        .map((comment) => ({
          id: comment.id,
          line: comment.line,
          side: comment.side,
          body: comment.body,
          heading: t(
            comment.side === "before"
              ? "lanes.review.comment.headingRemoved"
              : "lanes.review.comment.heading",
            { line: comment.line },
          ),
        })),
    [mine, editedId, t],
  );

  const run = async (mutate: (doc: ReviewDoc) => ReviewDoc): Promise<boolean> => {
    setBusy(true);
    const saved = await update(mutate);
    setBusy(false);
    return saved;
  };
  const saveNew = async (target: { line: number; side: "after" | "before" }, body: string) => {
    if (state.phase !== "ready") return;
    const text = target.side === "after" ? state.value.after : state.value.before;
    const { rpc } = getRuntime();
    const comment = {
      id: rpc.newCommandId(),
      path: file.path,
      side: target.side,
      line: target.line,
      excerpt: excerptOf(text, target.line),
      body,
      createdAt: Date.now(),
      sentAt: null,
      resolvedAt: null,
    };
    if (await run((current) => addComment(current, comment))) {
      dropDraft(target);
      setEditing(null);
    }
  };
  const ask = (line: number, side: "after" | "before") => {
    if (doc.comments.length >= LANE_LIMITS.comments) {
      setFull(true);
      return;
    }
    setFull(false);
    setEditing({ kind: "new", line, side });
  };

  let body;
  if (file.binary || (state.phase === "ready" && state.value.binary)) {
    body = <Note>{t("lanes.review.diff.binary")}</Note>;
  } else if (state.phase === "error") {
    body = (
      <div className="p-s3">
        <Banner
          tone="capacity"
          title={state.code === "timeout" ? t("lanes.review.diff.timeout") : t("lanes.review.diff.failed")}
          actions={
            <Button variant="secondary" size="sm" onClick={() => setAttempt((count) => count + 1)}>
              {t("lanes.review.retry")}
            </Button>
          }
        />
      </div>
    );
  } else if (state.phase === "ready" && state.value.truncated) {
    body = (
      <div className="flex flex-col items-start gap-s2 p-s3">
        <p role="status" className="text-ui text-muted">
          {t("lanes.review.diff.tooLarge")}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onOpenFile(`${worktree.replace(/\/$/, "")}/${file.path}`)}
        >
          {t("lanes.review.diff.openInFiles")}
        </Button>
      </div>
    );
  } else if (state.phase === "ready") {
    const target = editing?.kind === "new" ? editing : null;
    const typedKey = target === null ? "" : draftKey(target);
    body = (
      <ReviewDiffView
        before={state.value.before}
        after={state.value.after}
        language={language}
        labels={labels}
        comments={drawn}
        editing={target === null ? null : { line: target.line, side: target.side }}
        editor={
          target === null ? null : (
            <CommentEditor
              key={draftKey(target)}
              initial={drafts[draftKey(target)] ?? ""}
              busy={busy}
              onDraft={(text) => setDrafts((held) => ({ ...held, [typedKey]: text }))}
              onSave={(text) => void saveNew(target, text)}
              onCancel={() => {
                dropDraft(target);
                setEditing(null);
              }}
            />
          )
        }
        onComment={ask}
        onOpenComment={(id) => setEditing({ kind: "edit", id })}
        onLoadError={() => reportClientIssue("lazy_chunk_failed")}
      />
    );
  } else {
    body = (
      <div className="flex items-center gap-s2 p-s3 text-ui text-muted">
        <Spinner label={t("lanes.review.diff.loading")} />
      </div>
    );
  }

  const counts =
    file.binary || file.additions === null || file.deletions === null
      ? null
      : formatDiffCounts(file.additions, file.deletions);
  return (
    <div data-slot="review-file-diff" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-s2 border-b border-border px-s3 py-s1">
        <span data-slot="file-name" className="min-w-0 truncate font-mono text-code text-muted">
          {escapeHidden(file.path)}
        </span>
        {counts === null ? null : (
          <span className="font-mono text-code tabular-nums text-muted">{counts}</span>
        )}
      </div>
      {full ? (
        <div className="px-s3 py-s1">
          <InlineError announce="action">{t("lanes.review.comment.limit")}</InlineError>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      <CommentList
        comments={mine}
        editingId={editedId}
        busy={busy}
        onEdit={(id) => setEditing({ kind: "edit", id })}
        onSaveEdit={(id, text) =>
          void run((current) => editComment(current, id, text)).then((saved) => saved && setEditing(null))
        }
        onCancelEdit={() => setEditing(null)}
        onResolve={(id) => void run((current) => resolveComment(current, id, Date.now()))}
        onDelete={(id) => void run((current) => deleteComment(current, id))}
      />
    </div>
  );
}
