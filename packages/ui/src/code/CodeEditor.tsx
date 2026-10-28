import { lazy } from "react";
import { Lazy } from "./Lazy.tsx";
import type { LanguageLoader } from "./languages.ts";

const Editor = lazy(() => import("./CodeEditorView.tsx"));

export interface CodeLabels {
  /** The accessible name of the editing area. */
  readonly label: string;
  /** CodeMirror's own strings by their English phrase ("Find", "next", "close"...), translated by the caller. */
  readonly phrases?: Readonly<Record<string, string>>;
}

export interface CodeEditorProps {
  readonly value: string;
  /** Called with the whole text after each edit made in the editor (not for a change of `value`). */
  readonly onChange?: (text: string) => void;
  /** Mod-s: called with the current text. */
  readonly onSave?: (text: string) => void;
  readonly readOnly?: boolean;
  /** From `languageFor(path)`; null or absent is plain text. */
  readonly language?: LanguageLoader | null;
  readonly labels: CodeLabels;
  /** Puts the cursor on line `n` (clamped to the text) and scrolls it to the middle; a new `key` applies it again. */
  readonly line?: { readonly n: number; readonly key: number };
  /** The editor chunk or the language cannot load: the text stays plain. Called once per failure. */
  readonly onLoadError?: () => void;
}

/** The CodeMirror editor (viewer, editor), loaded on first use; the text shows at once and stays plain if the chunk fails. */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Lazy
      fallback={
        <pre
          data-slot="code-editor"
          data-state="plain"
          className="h-full overflow-auto p-s2 font-mono text-code text-fg"
        >
          {props.value}
        </pre>
      }
      onLoadError={props.onLoadError}
    >
      <Editor {...props} />
    </Lazy>
  );
}
