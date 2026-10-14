// The CodeMirror editor and the diff view live behind their own entry, never in the eager barrel: the editor
// stack loads on first use (spec C §7.4). Props are strings and callbacks; nothing here knows the contracts.
export { CodeEditor, type CodeEditorProps, type CodeLabels } from "./code/CodeEditor.tsx";
export { DiffView, type DiffViewProps } from "./code/DiffView.tsx";
export { languageFor, type LanguageLoader } from "./code/languages.ts";
