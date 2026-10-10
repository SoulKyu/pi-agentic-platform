import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, gutter, GutterMarker, lineNumbers, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { LineComment } from "./comments.ts";

declare const __SYNTAX__: boolean;

type Side = LineComment["side"];

class CommentMarker extends GutterMarker {
  override toDOM(): Node {
    const span = document.createElement("span");
    span.textContent = "+";
    span.title = "Comment on this line";
    return span;
  }
}
const marker = new CommentMarker();

class CommentWidget extends WidgetType {
  constructor(private readonly comment: LineComment) {
    super();
  }
  override eq(other: CommentWidget): boolean {
    return other.comment.line === this.comment.line && other.comment.side === this.comment.side && other.comment.text === this.comment.text;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "review-comment";
    el.textContent = this.comment.text;
    return el;
  }
}

/** Where a comment sits: after-side comments under their line, before-side ones above their deleted chunk (the chunk's DOM is the library's). */
function anchorOf(state: EditorState, comment: LineComment): Range<Decoration> | null {
  if (comment.side === "after") {
    const line = state.doc.line(comment.line);
    return Decoration.widget({ widget: new CommentWidget(comment), block: true, side: 1 }).range(line.to);
  }
  const startOfLine = getOriginalDoc(state).line(comment.line).from;
  const chunk = getChunks(state)?.chunks.find((c) => c.fromA <= startOfLine && startOfLine < c.toA);
  return chunk ? Decoration.widget({ widget: new CommentWidget(comment), block: true, side: -1 }).range(chunk.fromB) : null;
}

const setComments = StateEffect.define<readonly LineComment[]>();
const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setComments)) {
        const ranges = effect.value.flatMap((c) => anchorOf(tr.state, c) ?? []);
        return Decoration.set(ranges, true);
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The original line number of a deleted line the pointer hit, or null when the pointer hit something else. */
function deletedLineAt(view: EditorView, target: EventTarget | null): number | null {
  const lineEl = target instanceof Element ? target.closest(".cm-deletedLine") : null;
  const chunkEl = lineEl?.closest(".cm-deletedChunk");
  if (!lineEl || !chunkEl) return null;
  const index = Array.from(chunkEl.querySelectorAll(".cm-deletedLine")).indexOf(lineEl);
  const chunk = getChunks(view.state)?.chunks.find((c) => c.fromB === view.posAtDOM(chunkEl));
  return chunk ? getOriginalDoc(view.state).lineAt(chunk.fromA).number + index : null;
}

const tokenTheme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--surface)", fontFamily: "var(--font-mono)" },
  ".cm-gutters": { backgroundColor: "var(--bg-side)", color: "var(--text-dim)", border: "none" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "var(--diff-add)" },
  ".cm-deletedChunk": { backgroundColor: "var(--diff-del)" },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--ok)" },
  ".cm-deletedLineGutter": { background: "var(--err)" },
  ".cm-collapsedLines": { backgroundImage: "none", backgroundColor: "var(--surface-2)", color: "var(--text-muted)" },
  ".cm-changedText": { backgroundImage: "none", textDecoration: "underline", textDecorationColor: "var(--ok)" },
  ".cm-deletedChunk .cm-changedText": { textDecorationColor: "var(--err)" },
  ".cm-comment-gutter": { cursor: "pointer", color: "var(--you)" },
  ".cm-comment-gutter span": { visibility: "hidden" },
  ".cm-comment-gutter .cm-gutterElement:hover span": { visibility: "visible" },
});

const tokenHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "var(--agent)" },
  { tag: [tags.string, tags.regexp], color: "var(--ok)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--you)" },
  { tag: tags.comment, color: "var(--text-dim)", fontStyle: "italic" },
]);

export interface CodeMirrorReview {
  readonly setComments: (comments: readonly LineComment[]) => void;
  readonly destroy: () => void;
}

export function mountCodeMirrorReview(parent: HTMLElement, before: string, after: string, onComment: (line: number, side: Side) => void): CodeMirrorReview {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: after,
      extensions: [
        lineNumbers(),
        EditorView.editable.of(false),
        unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 } }),
        gutter({
          class: "cm-comment-gutter",
          lineMarker: () => marker,
          initialSpacer: () => marker,
          domEventHandlers: {
            mousedown: (editor, line) => {
              onComment(editor.state.doc.lineAt(line.from).number, "after");
              return true;
            },
          },
        }),
        commentField,
        tokenTheme,
        ...(__SYNTAX__ ? [javascript({ typescript: true }), syntaxHighlighting(tokenHighlight)] : []),
      ],
    }),
  });
  // Widgets swallow editor event handlers, so the deleted chunks' clicks are listened to on the editor's own element.
  view.dom.addEventListener("mousedown", (event) => {
    const line = deletedLineAt(view, event.target);
    if (line !== null) onComment(line, "before");
  });
  return { setComments: (comments) => view.dispatch({ effects: setComments.of(comments) }), destroy: () => view.destroy() };
}
