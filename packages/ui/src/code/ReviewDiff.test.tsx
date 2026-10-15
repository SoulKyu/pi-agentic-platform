// @vitest-environment happy-dom
import { getChunks } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { ReviewDiffView, type DiffComment, type ReviewDiffViewProps } from "./ReviewDiff.tsx";
import { REVIEW_THEME_SPEC } from "./review-gutter.ts";
import { showHidden } from "./review-text.ts";

const labels = { label: "Changes", noChanges: "No changes" };
const lines = (changed: Record<number, string> = {}, count = 60) =>
  Array.from({ length: count }, (_, index) => changed[index + 1] ?? `line ${index + 1}`).join("\n");

const after = lines({ 2: "changed 2", 42: "changed 42" });
const before = lines();
const noop = () => {};

async function ready() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

async function show(extra: Partial<ReviewDiffViewProps> = {}) {
  const props: ReviewDiffViewProps = {
    before,
    after,
    labels,
    comments: [],
    onComment: noop,
    onOpenComment: noop,
    ...extra,
  };
  const page = await mount(<ReviewDiffView {...props} />);
  await ready();
  const dom = page.container.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("no editor");
  return { page, view, root: page.container };
}

const press = async (target: Element, type: string, init: object = {}) => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
};
/** A mousedown on a gutter element, aimed at a document line by its height (happy-dom has no layout). */
const gutterPress = async (view: EditorView, selector: string, line: number) => {
  const target = view.dom.querySelector(selector);
  if (!target) throw new Error(`no ${selector}`);
  const block = view.lineBlockAt(view.state.doc.line(line).from);
  await press(target, "mousedown", { clientY: block.top + block.height / 2 });
};
const comment = (patch: Partial<DiffComment> = {}): DiffComment => ({
  id: "c-1",
  line: 42,
  side: "after",
  heading: "You · line 42",
  body: "Wrap with the lane id.",
  ...patch,
});

describe("ReviewDiffView", () => {
  it("asks for a comment on the after-side line whose gutter was pressed", async () => {
    const onComment = vi.fn();
    const { view } = await show({ onComment });
    await gutterPress(view, ".cm-review-gutter", 42);
    expect(onComment).toHaveBeenCalledExactlyOnceWith(42, "after");
  });

  it("asks for a comment when a line number is pressed too", async () => {
    const onComment = vi.fn();
    const { view } = await show({ onComment });
    await gutterPress(view, ".cm-lineNumbers", 2);
    expect(onComment).toHaveBeenCalledExactlyOnceWith(2, "after");
  });

  it("shows the + on every line, not only on hover", async () => {
    const { root } = await show();
    const marks = root.querySelectorAll(".cm-review-gutter .cm-review-add");
    expect(marks.length).toBeGreaterThan(2);
    expect(JSON.stringify(REVIEW_THEME_SPEC)).not.toContain("visibility");
  });

  it("asks for a before-side comment, with the old line number, when a deleted line is pressed", async () => {
    const onComment = vi.fn();
    const { root } = await show({
      before: lines({ 10: "old ten", 11: "old eleven" }, 30),
      after: lines({}, 30).replace("line 10\nline 11\n", ""),
      onComment,
    });
    const deleted = [...root.querySelectorAll(".cm-deletedLine")];
    expect(deleted).toHaveLength(2);
    await press(deleted[1] as Element, "mousedown");
    expect(onComment).toHaveBeenCalledExactlyOnceWith(11, "before");
  });

  it("draws a comment body as text, never as markup", async () => {
    const body = '<img src=x onerror="globalThis.hit=1">';
    const { root } = await show({ comments: [comment({ body, heading: "<b>You</b>" })] });
    const block = root.querySelector(".cm-review-comment");
    expect(block?.querySelector("p")?.textContent).toBe(body);
    expect(block?.querySelector("small")?.textContent).toBe("<b>You</b>");
    expect(root.querySelector(".cm-review-comment img, .cm-review-comment b")).toBeNull();
  });

  it("puts an after-side comment under its line and a before-side comment after the deleted chunk", async () => {
    const { root, view } = await show({
      before: lines({ 10: "old ten" }, 30),
      after: lines({}, 30).replace("line 10\n", ""),
      comments: [
        comment({ id: "a", line: 9, side: "after" }),
        comment({ id: "b", line: 10, side: "before" }),
      ],
    });
    const blocks = [...root.querySelectorAll<HTMLElement>(".cm-review-comment")];
    expect(blocks.map((block) => block.dataset.commentId)).toEqual(["a", "b"]);
    const chunk = root.querySelector(".cm-deletedChunk");
    const second = blocks[1];
    expect(
      chunk && second && chunk.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getChunks(view.state)?.chunks).toHaveLength(1);
  });

  it("leaves out a comment whose line is gone, without failing", async () => {
    const { root } = await show({
      comments: [comment({ id: "gone", line: 9999 }), comment({ id: "gone2", line: 99, side: "before" })],
    });
    expect(root.querySelectorAll(".cm-review-comment")).toHaveLength(0);
  });

  it("opens a comment on a click and on Enter", async () => {
    const onOpenComment = vi.fn();
    const { root } = await show({ comments: [comment()], onOpenComment });
    const block = root.querySelector<HTMLElement>(".cm-review-comment") as HTMLElement;
    await press(block, "click");
    expect(onOpenComment).toHaveBeenLastCalledWith("c-1");
    await act(async () => {
      block.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onOpenComment).toHaveBeenCalledTimes(2);
  });

  it("follows the comment list when it changes", async () => {
    const page = await mount(
      <ReviewDiffView
        before={before}
        after={after}
        labels={labels}
        comments={[]}
        onComment={noop}
        onOpenComment={noop}
      />,
    );
    await ready();
    expect(page.container.querySelectorAll(".cm-review-comment")).toHaveLength(0);
    await page.rerender(
      <ReviewDiffView
        before={before}
        after={after}
        labels={labels}
        comments={[comment()]}
        onComment={noop}
        onOpenComment={noop}
      />,
    );
    expect(page.container.querySelectorAll(".cm-review-comment")).toHaveLength(1);
  });

  it("renders the editor passed in under the line being commented, inside the diff", async () => {
    const { root } = await show({
      editing: { line: 42, side: "after" },
      editor: <textarea data-testid="ed" />,
    });
    const host = root.querySelector(".cm-review-editor");
    expect(host?.querySelector("textarea")).not.toBeNull();
  });

  it("jumps between hunks with ] and [, and comments on the cursor line with c", async () => {
    const onComment = vi.fn();
    const { view } = await show({ onComment });
    const key = async (value: string) => {
      await act(async () => {
        view.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
        );
      });
    };
    await key("]");
    const first = view.state.doc.lineAt(view.state.selection.main.head).number;
    await key("]");
    const second = view.state.doc.lineAt(view.state.selection.main.head).number;
    expect([first, second]).toEqual([2, 42]);
    await key("[");
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    await key("c");
    expect(onComment).toHaveBeenCalledExactlyOnceWith(2, "after");
  });

  it("writes hidden characters of the lines as visible escapes and keeps the line count", async () => {
    const { view } = await show({
      before: "a\nb",
      after: "a\nb\u202Ec\u200Bd\rx",
    });
    expect(view.state.doc.toString()).toBe("a\nb\\u202Ec\\u200Bd\\u000Dx");
    expect(view.state.doc.lines).toBe(2);
  });

  it("says No changes and mounts no editor for identical texts", async () => {
    const page = await mount(
      <ReviewDiffView
        before="x"
        after="x"
        labels={labels}
        comments={[]}
        onComment={noop}
        onOpenComment={noop}
      />,
    );
    expect(page.container.textContent).toContain("No changes");
    expect(page.container.querySelector(".cm-editor")).toBeNull();
  });
});

describe("showHidden", () => {
  it("writes control, bidi, zero-width and lookalike blank characters", () => {
    expect(showHidden("a\u202Eb\u200Bc\u00A0d\u0000\u0085\u2028")).toBe(
      "a\\u202Eb\\u200Bc\\u00A0d\\u0000\\u0085\\u2028",
    );
    expect(showHidden("\u{E0041}")).toBe("\\u{E0041}");
  });

  it("keeps newlines, CRLF pairs, tabs and plain spaces, and writes a lone CR", () => {
    expect(showHidden("a b\tc\nd\r\ne\rf")).toBe("a b\tc\nd\r\ne\\u000Df");
  });
});

describe("the review theme", () => {
  it("writes every colour as a pap token", () => {
    for (const [selector, rules] of Object.entries(REVIEW_THEME_SPEC))
      for (const [property, value] of Object.entries(rules)) {
        expect(value, `${selector} ${property}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
        if (/^(?:color|backgroundColor|borderColor)$/.test(property))
          expect(value, `${selector} ${property}`).toMatch(/^var\(--[a-z0-9-]+\)$/);
      }
    expect(JSON.stringify(REVIEW_THEME_SPEC)).toContain("var(--you-tint)");
    expect(JSON.stringify(REVIEW_THEME_SPEC)).toContain("var(--you-line)");
    expect(JSON.stringify(REVIEW_THEME_SPEC)).toContain("var(--you-text)");
  });
});
