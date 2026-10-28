// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { CodeEditor } from "./CodeEditor.tsx";

const labels = { label: "File content" };
const TEXT = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");

async function ready() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

const viewOf = (container: HTMLElement): EditorView => {
  const dom = container.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("no editor mounted");
  return view;
};
const lineOfCursor = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number;

describe("CodeEditor line target", () => {
  it("a line request puts the cursor on that line, and a new key applies it again after the cursor moved", async () => {
    const page = await mount(<CodeEditor value={TEXT} line={{ n: 12, key: 1 }} labels={labels} />);
    await ready();
    const view = viewOf(page.container);
    expect(lineOfCursor(view)).toBe(12);
    await act(async () => view.dispatch({ selection: { anchor: 0 } }));
    expect(lineOfCursor(view)).toBe(1);
    await page.rerender(<CodeEditor value={TEXT} line={{ n: 12, key: 1 }} labels={labels} />);
    expect(lineOfCursor(view)).toBe(1);
    await page.rerender(<CodeEditor value={TEXT} line={{ n: 12, key: 2 }} labels={labels} />);
    expect(lineOfCursor(view)).toBe(12);
  });

  it("a line past the end lands on the last line", async () => {
    const page = await mount(<CodeEditor value={TEXT} line={{ n: 9_999, key: 1 }} labels={labels} />);
    await ready();
    expect(lineOfCursor(viewOf(page.container))).toBe(20);
  });
});
