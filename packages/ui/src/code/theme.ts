import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags, type Tag } from "@lezer/highlight";

type Rules = Record<string, Record<string, string>>;

const TEXT = "var(--text)";
const MUTED = "var(--text-muted)";

/**
 * Every colour is a pap token (`var(--…)`), resolved by the browser where the editor sits: a theme switch
 * changes the variables and needs no re-render. The dark flag is not set: nothing here depends on it.
 */
export const THEME_SPEC: Rules = {
  "&": {
    color: TEXT,
    backgroundColor: "var(--bg)",
    fontFamily: "var(--font-code)",
    fontSize: "var(--size-code)",
    height: "100%",
  },
  "&.cm-focused": { outlineColor: "var(--focus-ring)" },
  ".cm-scroller": { fontFamily: "var(--font-code)", lineHeight: "1.5" },
  ".cm-content": { caretColor: TEXT },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: TEXT },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--you-tint)" },
  ".cm-activeLine": { backgroundColor: "var(--surface)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--text-dim)",
    borderRightColor: "var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface)", color: MUTED },
  ".cm-lineNumbers .cm-gutterElement": { color: "var(--text-dim)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-2)", borderColor: "var(--border)", color: MUTED },
  ".cm-matchingBracket": { backgroundColor: "var(--surface-2)", outlineColor: "var(--border-strong)" },
  ".cm-nonmatchingBracket": { backgroundColor: "var(--surface-2)", color: "var(--err)" },
  ".cm-selectionMatch": { backgroundColor: "var(--surface-2)" },
  ".cm-searchMatch": { backgroundColor: "var(--you-tint)", outlineColor: "var(--you-line)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--you-line)" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: TEXT },
  ".cm-panels.cm-panels-top": { borderBottomColor: "var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTopColor: "var(--border)" },
  ".cm-panel input, .cm-panel button, .cm-panel label": { color: TEXT, fontFamily: "var(--font-ui)" },
  ".cm-panel input": { backgroundColor: "var(--bg)", borderColor: "var(--control-border)" },
  ".cm-panel button": { backgroundColor: "var(--surface-2)", borderColor: "var(--border-strong)" },
  // The base theme paints the search panel in light greys (a gradient on the buttons, white inputs) and leaks under
  // night and high contrast: every control of the panel is restated on tokens.
  ".cm-panel": { backgroundColor: "var(--surface)", color: TEXT },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--surface-2)",
    borderColor: "var(--border-strong)",
    color: TEXT,
  },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--surface)" },
  ".cm-textfield": { backgroundColor: "var(--bg)", borderColor: "var(--control-border)", color: TEXT },
  ".cm-panel.cm-search label": { color: TEXT },
  ".cm-panel.cm-search [name=close]": { color: MUTED },
  ".cm-textfield:focus, .cm-button:focus-visible": {
    outlineColor: "var(--focus-ring)",
    outlineStyle: "solid",
    outlineWidth: "2px",
  },
  ".cm-tooltip": { backgroundColor: "var(--surface-2)", borderColor: "var(--border-strong)", color: TEXT },
  // The merge view's own colours (S5): changed lines on the diff tokens, deleted chunks on the deletion one.
  ".cm-changedLine, .cm-insertedLine": { backgroundColor: "var(--diff-add)" },
  ".cm-deletedLine": { backgroundColor: "var(--diff-del)" },
  ".cm-deletedChunk": { backgroundColor: "var(--diff-del)", color: TEXT },
  ".cm-deletedChunk .cm-deletedLine": { backgroundColor: "var(--diff-del)" },
  ".cm-changedText, .cm-insertedText, ins.cm-insertedLine, ins.cm-insertedLine .cm-changedText": {
    background: "var(--diff-add)",
  },
  ".cm-deletedChunk .cm-changedText, del.cm-deletedLine, del": { background: "var(--diff-del)" },
  ".cm-changedLineGutter": { backgroundColor: "var(--ok)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--err)" },
  ".cm-collapsedLines": { backgroundColor: "var(--surface-2)", color: MUTED },
  ".cm-collapsedLines:hover": { color: TEXT },
};

/** Roles, not a rainbow (DESIGN §2): keywords and types in the agent hue, comments and punctuation muted. */
export const HIGHLIGHT_SPEC: readonly {
  name: string;
  tag: Tag | readonly Tag[];
  style: Record<string, string>;
}[] = [
  {
    name: "keyword",
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    style: { color: "var(--agent)" },
  },
  { name: "type", tag: [tags.typeName, tags.className, tags.namespace], style: { color: "var(--agent)" } },
  { name: "comment", tag: [tags.comment, tags.docComment], style: { color: MUTED, fontStyle: "italic" } },
  { name: "punctuation", tag: [tags.punctuation, tags.separator, tags.bracket], style: { color: MUTED } },
  { name: "string", tag: [tags.string, tags.regexp, tags.special(tags.string)], style: { color: TEXT } },
  { name: "literal", tag: [tags.number, tags.bool, tags.null, tags.atom], style: { color: TEXT } },
  {
    name: "definition",
    tag: [tags.definition(tags.variableName), tags.function(tags.variableName)],
    style: { color: TEXT },
  },
  { name: "heading", tag: [tags.heading], style: { color: TEXT, fontWeight: "700" } },
  { name: "emphasis", tag: [tags.emphasis], style: { fontStyle: "italic" } },
  { name: "strong", tag: [tags.strong], style: { fontWeight: "700" } },
  {
    name: "link",
    tag: [tags.link, tags.url],
    style: { color: "var(--agent)", textDecorationColor: "var(--agent)" },
  },
  { name: "meta", tag: [tags.meta, tags.processingInstruction], style: { color: MUTED } },
  { name: "invalid", tag: [tags.invalid], style: { color: "var(--err)" } },
];

const HIGHLIGHT = HighlightStyle.define(HIGHLIGHT_SPEC.map(({ tag, style }) => ({ tag, ...style })));

/** The theme and the highlighting, as extensions. */
export const papTheme: Extension = [EditorView.theme(THEME_SPEC), syntaxHighlighting(HIGHLIGHT)];
