import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export type DiffSideName = "after" | "before";

/** A comment as the view draws it; the text reaches the DOM as `textContent` only. */
export interface DiffComment {
  readonly id: string;
  readonly line: number;
  readonly side: DiffSideName;
  /** "You · line 42", built by the caller (it owns the words). */
  readonly heading: string;
  readonly body: string;
  readonly resolved?: boolean;
}

export interface EditingTarget {
  readonly line: number;
  readonly side: DiffSideName;
}

export const setComments = StateEffect.define<readonly DiffComment[]>();
export const setEditing = StateEffect.define<EditingTarget | null>();

class CommentWidget extends WidgetType {
  private readonly comment: DiffComment;

  constructor(comment: DiffComment) {
    super();
    this.comment = comment;
  }

  override eq(other: CommentWidget): boolean {
    const a = this.comment;
    const b = other.comment;
    return a.id === b.id && a.heading === b.heading && a.body === b.body && a.resolved === b.resolved;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-review-comment";
    element.dataset.commentId = this.comment.id;
    element.dataset.side = this.comment.side;
    if (this.comment.resolved === true) element.dataset.resolved = "true";
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    const heading = element.appendChild(document.createElement("small"));
    heading.textContent = this.comment.heading;
    const body = element.appendChild(document.createElement("p"));
    body.textContent = this.comment.body;
    return element;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** The host of the inline editor: the pane renders its textarea into it with a portal. */
class EditorWidget extends WidgetType {
  private readonly target: EditingTarget;
  private readonly onHost: (host: HTMLElement | null) => void;

  constructor(target: EditingTarget, onHost: (host: HTMLElement | null) => void) {
    super();
    this.target = target;
    this.onHost = onHost;
  }

  override eq(other: EditorWidget): boolean {
    return other.target.line === this.target.line && other.target.side === this.target.side;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-review-editor";
    this.onHost(element);
    return element;
  }

  override destroy(): void {
    this.onHost(null);
  }
}

/** Where a line's widgets sit: after-side under their line, before-side after the deleted chunk (S5's stated limit). */
function anchorOf(
  state: EditorState,
  side: DiffSideName,
  line: number,
): { readonly pos: number; readonly side: number } | null {
  if (side === "after") {
    if (line < 1 || line > state.doc.lines) return null;
    return { pos: state.doc.line(line).to, side: 1 };
  }
  const original = getOriginalDoc(state);
  if (line < 1 || line > original.lines) return null;
  const start = original.line(line).from;
  const chunk = getChunks(state)?.chunks.find((c) => c.fromA <= start && start < c.toA);
  // Side 0 sorts after the merge view's own deleted chunk (side -1) at the same position.
  return chunk ? { pos: chunk.fromB, side: 0 } : null;
}

interface Held {
  readonly comments: readonly DiffComment[];
  readonly editing: EditingTarget | null;
  readonly set: DecorationSet;
}

function build(
  state: EditorState,
  comments: readonly DiffComment[],
  editing: EditingTarget | null,
  onHost: (host: HTMLElement | null) => void,
): Held {
  const ranges: Range<Decoration>[] = [];
  for (const comment of comments) {
    const at = anchorOf(state, comment.side, comment.line);
    if (at)
      ranges.push(
        Decoration.widget({ widget: new CommentWidget(comment), block: true, side: at.side }).range(at.pos),
      );
  }
  const place = editing ? anchorOf(state, editing.side, editing.line) : null;
  if (editing && place) {
    ranges.push(
      Decoration.widget({
        widget: new EditorWidget(editing, onHost),
        block: true,
        side: place.side + (editing.side === "after" ? 1 : 0),
      }).range(place.pos),
    );
  }
  return { comments, editing, set: Decoration.set(ranges, true) };
}

/** The comment blocks and the editor host, kept in one field so their order under a line is fixed. */
export function reviewWidgets(
  initial: { readonly comments: readonly DiffComment[]; readonly editing: EditingTarget | null },
  onHost: (host: HTMLElement | null) => void,
): Extension {
  const field = StateField.define<Held>({
    create: (state) => build(state, initial.comments, initial.editing, onHost),
    update(held, transaction) {
      let { comments, editing } = held;
      let changed = false;
      for (const effect of transaction.effects) {
        if (effect.is(setComments)) {
          comments = effect.value;
          changed = true;
        } else if (effect.is(setEditing)) {
          editing = effect.value;
          changed = true;
        }
      }
      return changed ? build(transaction.state, comments, editing, onHost) : held;
    },
    provide: (self) => EditorView.decorations.from(self, (held) => held.set),
  });
  return field;
}
