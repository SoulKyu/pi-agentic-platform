import { unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { DiffViewProps } from "./DiffView.tsx";
import { loadLanguage } from "./languages.ts";
import { papTheme } from "./theme.ts";

/** The implementation behind `DiffView`: the merge view is read-only, with long unchanged stretches folded. */
export default function DiffPane({ before, after, language, labels, onLoadError }: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const report = useRef(onLoadError);
  useEffect(() => {
    report.current = onLoadError;
  });
  const { label } = labels;
  const phrases = JSON.stringify(labels.phrases ?? {});

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const slot = new Compartment();
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: after,
        extensions: [
          EditorState.readOnly.of(true),
          EditorState.phrases.of(JSON.parse(phrases) as Record<string, string>),
          EditorView.contentAttributes.of({ "aria-label": label, inputmode: "none" }),
          drawSelection({ cursorBlinkRate: 0 }),
          papTheme,
          slot.of([]),
          unifiedMergeView({
            original: before,
            collapseUnchanged: { margin: 3, minSize: 4 },
            mergeControls: false,
          }),
        ],
      }),
    });
    let current = true;
    void loadLanguage(language ?? null, () => report.current?.()).then((extension) => {
      if (current) view.dispatch({ effects: slot.reconfigure(extension) });
    });
    return () => {
      current = false;
      view.destroy();
    };
  }, [before, after, language, label, phrases]);

  return <div ref={host} data-slot="diff-view" data-state="ready" className="h-full min-h-0" />;
}
