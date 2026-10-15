import type { ReviewComment } from "@pap/contracts";
import { Button } from "@pap/ui";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/index.ts";
import { CommentEditor } from "./CommentEditor.tsx";
import "./register-review-catalog.ts";

interface CommentListProps {
  readonly comments: readonly ReviewComment[];
  readonly editingId: string | null;
  readonly busy: boolean;
  onEdit(id: string): void;
  onSaveEdit(id: string, body: string): void;
  onCancelEdit(): void;
  onResolve(id: string): void;
  onDelete(id: string): void;
}

function Row({
  comment,
  editing,
  busy,
  ...actions
}: Omit<CommentListProps, "comments" | "editingId"> & {
  readonly comment: ReviewComment;
  readonly editing: boolean;
}) {
  const t = useT();
  const row = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (editing) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [editing]);
  const heading = t(
    comment.side === "before" ? "lanes.review.comment.headingRemoved" : "lanes.review.comment.heading",
    { line: comment.line },
  );
  return (
    <li ref={row} data-comment-id={comment.id} className="flex flex-col gap-s1 border-b border-border py-s2">
      <span className="label-hud text-you">
        {heading}
        {comment.resolvedAt !== null ? ` · ${t("lanes.review.comment.resolved")}` : ""}
        {comment.sentAt !== null ? ` · ${t("lanes.review.comment.sent")}` : ""}
      </span>
      {editing ? (
        <CommentEditor
          initial={comment.body}
          busy={busy}
          onSave={(body) => actions.onSaveEdit(comment.id, body)}
          onCancel={actions.onCancelEdit}
        />
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-ui text-fg">{comment.body}</p>
          <div className="flex gap-s2">
            <Button variant="ghost" size="sm" onClick={() => actions.onEdit(comment.id)}>
              {t("lanes.review.comment.edit")}
            </Button>
            {comment.resolvedAt === null ? (
              <Button variant="ghost" size="sm" onClick={() => actions.onResolve(comment.id)}>
                {t("lanes.review.comment.resolve")}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => actions.onDelete(comment.id)}>
              {t("lanes.review.comment.delete")}
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

/** The comments on the open file, with Edit (clears `sentAt`), Resolve and Delete (M9R89). Text only. */
export function CommentList({ comments, editingId, ...rest }: CommentListProps) {
  const t = useT();
  if (comments.length === 0) return null;
  return (
    <section
      data-review-comments
      aria-label={t("lanes.review.comment.list")}
      className="max-h-pane shrink-0 overflow-y-auto border-t border-border px-s3"
    >
      <ul className="flex flex-col">
        {comments.map((comment) => (
          <Row key={comment.id} comment={comment} editing={comment.id === editingId} {...rest} />
        ))}
      </ul>
    </section>
  );
}
