import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, search } from "@codemirror/search";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { CodeEditorProps } from "./CodeEditor.tsx";
import { loadLanguage } from "./languages.ts";
import { papTheme } from "./theme.ts";

const FROM_PROPS = Annotation.define<boolean>();

/** The implementation behind `CodeEditor`: every CodeMirror import of the editor is here, in the lazy chunk. */
export default function CodeEditorView(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const view = useRef<EditorView | null>(null);
  const mode = useRef(new Compartment());
  const language = useRef(new Compartment());
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (target) => {
                latest.current.onSave?.(target.state.doc.toString());
                return true;
              },
            },
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          history(),
          search({ top: true }),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection({ cursorBlinkRate: 0 }),
          papTheme,
          mode.current.of([]),
          language.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(FROM_PROPS)))
              latest.current.onChange?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  const { value, labels } = props;
  const readOnly = props.readOnly ?? false;
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== value)
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
        annotations: FROM_PROPS.of(true),
      });
  }, [value]);

  const lineKey = props.line?.key;
  useEffect(() => {
    const target = latest.current.line;
    const current = view.current;
    if (!target || !current) return;
    const wanted = Number.isFinite(target.n) ? Math.trunc(target.n) : 1;
    const from = current.state.doc.line(Math.min(Math.max(wanted, 1), current.state.doc.lines)).from;
    current.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }, [lineKey]);

  const { label } = labels;
  const phrases = JSON.stringify(labels.phrases ?? {});
  useEffect(() => {
    view.current?.dispatch({
      effects: mode.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        // CodeMirror's flag stops its own input handling only: this refuses every other change but the parent's.
        EditorState.transactionFilter.of((tr) =>
          readOnly && tr.docChanged && !tr.annotation(FROM_PROPS) ? [] : tr,
        ),
        EditorState.phrases.of(JSON.parse(phrases) as Record<string, string>),
        EditorView.contentAttributes.of({
          "aria-label": label,
          ...(readOnly ? { inputmode: "none" } : {}),
        }),
      ]),
    });
  }, [readOnly, label, phrases]);

  const loader = props.language ?? null;
  useEffect(() => {
    let current = true;
    void loadLanguage(loader, () => latest.current.onLoadError?.()).then((extension) => {
      if (current) view.current?.dispatch({ effects: language.current.reconfigure(extension) });
    });
    return () => {
      current = false;
    };
  }, [loader]);

  return <div ref={host} data-slot="code-editor" data-state="ready" className="h-full min-h-0" />;
}
