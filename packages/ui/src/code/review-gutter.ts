import { getChunks, getOriginalDoc } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, lineNumbers } from "@codemirror/view";
import type { DiffSideName } from "./review-widgets.ts";

export type CommentRequest = (line: number, side: DiffSideName) => void;

class AddMarker extends GutterMarker {
  override toDOM(): Node {
    const mark = document.createElement("span");
    mark.className = "cm-review-add";
    mark.textContent = "+";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }
}
const ADD = new AddMarker();

/**
 * The comment gutter: a `+` on every line at the muted tone (touch has no hover, S5's trap). A press on it, or on a
 * line number, asks for a comment on that after-side line.
 */
export function commentGutter(ask: CommentRequest): Extension {
  const press = (view: EditorView, line: { readonly from: number }) => {
    ask(view.state.doc.lineAt(line.from).number, "after");
    return true;
  };
  return [
    lineNumbers({ domEventHandlers: { mousedown: press } }),
    gutter({
      class: "cm-review-gutter",
      lineMarker: () => ADD,
      initialSpacer: () => ADD,
      domEventHandlers: { mousedown: press },
    }),
  ];
}

/** The line number in the original document of the deleted line the pointer hit, or null for anything else. */
export function deletedLineAt(view: EditorView, target: EventTarget | null): number | null {
  const lineElement = target instanceof Element ? target.closest(".cm-deletedLine") : null;
  const chunkElement = lineElement?.closest(".cm-deletedChunk");
  if (!lineElement || !chunkElement) return null;
  const index = [...chunkElement.querySelectorAll(".cm-deletedLine")].indexOf(lineElement);
  const at = view.posAtDOM(chunkElement);
  const chunk = getChunks(view.state)?.chunks.find((candidate) => candidate.fromB === at);
  if (!chunk) return null;
  return getOriginalDoc(view.state).lineAt(chunk.fromA).number + index;
}

/**
 * Deleted lines live in widgets, which swallow the editor's own handlers (S5): a plain listener on the editor's element
 * finds them by class. Comment blocks open on a click or on Enter.
 */
export function listenToWidgets(
  view: EditorView,
  handlers: { ask: CommentRequest; open(id: string): void },
): void {
  view.dom.addEventListener("mousedown", (event) => {
    const line = deletedLineAt(view, event.target);
    if (line !== null) handlers.ask(line, "before");
  });
  const commentOf = (event: Event): string | null => {
    const block =
      event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-review-comment") : null;
    return block?.dataset.commentId ?? null;
  };
  view.dom.addEventListener("click", (event) => {
    const id = commentOf(event);
    if (id !== null) handlers.open(id);
  });
  view.dom.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const id = commentOf(event);
    if (id === null) return;
    event.preventDefault();
    handlers.open(id);
  });
}

/** Colours are tokens (`--you-*` for comments, the diff and status tokens elsewhere); spacing is the `--space-*` scale. */
export const REVIEW_THEME_SPEC: Record<string, Record<string, string>> = {
  ".cm-review-gutter": { color: "var(--text-dim)", cursor: "pointer", minWidth: "var(--space-4)" },
  ".cm-review-gutter .cm-gutterElement": { textAlign: "center" },
  ".cm-review-gutter .cm-gutterElement:hover": { color: "var(--you-text)" },
  ".cm-lineNumbers .cm-gutterElement": { cursor: "pointer", color: "var(--text-dim)" },
  ".cm-review-comment": {
    margin: "var(--space-1) var(--space-3) var(--space-1) var(--space-5)",
    padding: "var(--space-2)",
    border: "1px solid var(--you-line)",
    borderRadius: "3px",
    backgroundColor: "var(--you-tint)",
    color: "var(--you-text)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--size-ui)",
    cursor: "pointer",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ".cm-review-comment small": {
    display: "block",
    color: "var(--you)",
    fontFamily: "var(--font-code)",
    textTransform: "var(--label-transform)",
    letterSpacing: "0.12em",
  },
  ".cm-review-comment p": { margin: "0" },
  ".cm-review-comment[data-resolved]": { opacity: "0.6" },
  ".cm-review-comment:focus-visible": { outline: "2px solid var(--focus-ring)" },
  ".cm-review-editor": { margin: "var(--space-1) var(--space-3) var(--space-1) var(--space-5)" },
};
