// @vitest-environment happy-dom
import { insertNewline } from "@codemirror/commands";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { CodeEditor } from "./CodeEditor.tsx";

const labels = { label: "File content" };

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

describe("CodeEditor", () => {
  it("shows the text at once and mounts .cm-editor with the value once its chunk is in", async () => {
    const page = await mount(<CodeEditor value={"one\ntwo"} labels={labels} />);
    expect(page.container.textContent).toContain("one");
    await ready();
    expect(page.container.querySelector(".cm-editor")).not.toBeNull();
    expect(viewOf(page.container).state.doc.toString()).toBe("one\ntwo");
    expect(page.container.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("File content");
  });

  it("follows a new value from the parent without calling onChange", async () => {
    const onChange = vi.fn();
    const page = await mount(<CodeEditor value="a" onChange={onChange} labels={labels} />);
    await ready();
    await page.rerender(<CodeEditor value="b" onChange={onChange} labels={labels} />);
    expect(viewOf(page.container).state.doc.toString()).toBe("b");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onChange with the new text on an edit", async () => {
    const onChange = vi.fn();
    const page = await mount(<CodeEditor value="a" onChange={onChange} labels={labels} />);
    await ready();
    const view = viewOf(page.container);
    await act(async () => view.dispatch({ changes: { from: 1, insert: "bc" } }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("abc");
  });

  it("refuses a typed change when readOnly, and takes it when not", async () => {
    const page = await mount(<CodeEditor value="a" readOnly labels={labels} />);
    await ready();
    const view = viewOf(page.container);
    insertNewline(view);
    expect(view.state.doc.toString()).toBe("a");
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("inputmode")).toBe("none");
    await page.rerender(<CodeEditor value="a" labels={labels} />);
    expect(view.state.readOnly).toBe(false);
    expect(view.contentDOM.getAttribute("inputmode")).toBeNull();
    insertNewline(view);
    expect(view.state.doc.toString()).toBe("\na");
  });

  it("calls onSave with the current text on Mod-s and keeps the browser's save dialog away", async () => {
    const onSave = vi.fn();
    const page = await mount(<CodeEditor value="a" onSave={onSave} labels={labels} />);
    await ready();
    const view = viewOf(page.container);
    await act(async () => view.dispatch({ changes: { from: 1, insert: "!" } }));
    const mac = /Mac|iP(hone|ad)/.test(navigator.platform);
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: !mac, metaKey: mac, cancelable: true });
    expect(runScopeHandlers(view, event, "editor")).toBe(true);
    expect(onSave).toHaveBeenCalledExactlyOnceWith("a!");
  });

  it("applies the language loaded for it", async () => {
    const loader = vi.fn(async () => (await import("@codemirror/lang-json")).json());
    const page = await mount(<CodeEditor value='{"a":1}' language={loader} labels={labels} />);
    await ready();
    await ready();
    expect(loader).toHaveBeenCalledOnce();
    expect(page.container.querySelector(".cm-editor")).not.toBeNull();
  });

  it("stays plain text and reports once when the language cannot load", async () => {
    const onLoadError = vi.fn();
    const loader = vi.fn(() => Promise.reject(new Error("gone")));
    const page = await mount(
      <CodeEditor value="x" language={loader} onLoadError={onLoadError} labels={labels} />,
    );
    await ready();
    await ready();
    expect(onLoadError).toHaveBeenCalledOnce();
    expect(viewOf(page.container).state.doc.toString()).toBe("x");
  });
});
