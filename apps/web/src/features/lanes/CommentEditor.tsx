import { LANE_LIMITS } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import "./register-review-catalog.ts";

interface CommentEditorProps {
  readonly initial: string;
  readonly busy: boolean;
  onSave(body: string): void;
  onCancel(): void;
  /** Every change of the text, so the caller can keep it when the editor goes away without a save or a cancel. */
  onDraft?(body: string): void;
}

/** A comment's text box (M9R89): Save, Cancel, Escape cancels, Mod+Enter saves, at most 4 000 characters. */
export function CommentEditor({ initial, busy, onSave, onCancel, onDraft }: CommentEditorProps) {
  const t = useT();
  const [body, setBody] = useState(initial);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const save = () => {
    if (body.trim() !== "" && !busy) onSave(body);
  };
  return (
    <div
      data-review-editor
      className="flex flex-col gap-s2 rounded-md border border-you-line bg-you-tint p-s2"
    >
      <TextField
        label={t("lanes.review.comment.field")}
        value={body}
        multiline
        ground="surface"
        rows={3}
        inputRef={input}
        onChange={(next) => {
          const kept = next.slice(0, LANE_LIMITS.commentBody);
          setBody(kept);
          onDraft?.(kept);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
        onSubmitShortcut={save}
        hint={t("lanes.review.comment.hint", { count: body.length, max: LANE_LIMITS.commentBody })}
      />
      <div className="flex justify-end gap-s2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {t("lanes.review.comment.cancel")}
        </Button>
        <Button variant="primary" size="sm" disabled={body.trim() === "" || busy} onClick={save}>
          {t("lanes.review.comment.save")}
        </Button>
      </div>
    </div>
  );
}
