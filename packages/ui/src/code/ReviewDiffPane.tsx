import { goToNextChunk, goToPreviousChunk, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadLanguage } from "./languages.ts";
import type { ReviewDiffViewProps } from "./ReviewDiff.tsx";
import { commentGutter, listenToWidgets, REVIEW_THEME_SPEC } from "./review-gutter.ts";
import { showHidden } from "./review-text.ts";
import { reviewWidgets, setComments, setEditing } from "./review-widgets.ts";
import { papTheme } from "./theme.ts";

const reviewTheme = EditorView.theme(REVIEW_THEME_SPEC);

/**
 * The implementation behind `ReviewDiffView`: S5's CodeMirror glue. The merge view is read-only and folds long
 * unchanged stretches; the sides are written with their hidden characters visible before the editor sees them.
 * Keys: `]` and `[` jump between hunks, `c` comments on the line of the cursor.
 */
export default function ReviewDiffPane(props: ReviewDiffViewProps) {
  const { before, after, language, labels } = props;
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  const view = useRef<EditorView | null>(null);
  const [editorHost, setEditorHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    live.current = props;
  });
  const shown = useMemo(() => ({ before: showHidden(before), after: showHidden(after) }), [before, after]);
  const phrases = JSON.stringify(labels.phrases ?? {});
  const { label } = labels;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const slot = new Compartment();
    const ask = (line: number, side: "after" | "before") => live.current.onComment(line, side);
    const next = new EditorView({
      parent,
      state: EditorState.create({
        doc: shown.after,
        extensions: [
          EditorState.readOnly.of(true),
          EditorState.phrases.of(JSON.parse(phrases) as Record<string, string>),
          EditorView.contentAttributes.of({ "aria-label": label, inputmode: "none" }),
          drawSelection({ cursorBlinkRate: 0 }),
          papTheme,
          reviewTheme,
          slot.of([]),
          unifiedMergeView({
            original: shown.before,
            collapseUnchanged: { margin: 3, minSize: 4 },
            mergeControls: false,
          }),
          commentGutter(ask),
          reviewWidgets(
            { comments: live.current.comments, editing: live.current.editing ?? null },
            setEditorHost,
          ),
          Prec.high(
            keymap.of([
              { key: "]", run: goToNextChunk },
              { key: "[", run: goToPreviousChunk },
              {
                key: "c",
                run: (target) => {
                  ask(target.state.doc.lineAt(target.state.selection.main.head).number, "after");
                  return true;
                },
              },
            ]),
          ),
        ],
      }),
    });
    view.current = next;
    listenToWidgets(next, { ask, open: (id) => live.current.onOpenComment(id) });
    let current = true;
    void loadLanguage(language ?? null, () => live.current.onLoadError?.()).then((extension) => {
      if (current) next.dispatch({ effects: slot.reconfigure(extension) });
    });
    return () => {
      current = false;
      view.current = null;
      setEditorHost(null);
      next.destroy();
    };
  }, [shown, language, label, phrases]);

  const { comments, editing } = props;
  useEffect(() => {
    view.current?.dispatch({ effects: [setComments.of(comments), setEditing.of(editing ?? null)] });
  }, [comments, editing]);

  return (
    <div ref={host} data-slot="review-diff" data-state="ready" className="h-full min-h-0">
      {editorHost !== null && props.editor ? createPortal(props.editor, editorHost) : null}
    </div>
  );
}
