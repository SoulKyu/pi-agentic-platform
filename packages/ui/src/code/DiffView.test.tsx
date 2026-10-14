// @vitest-environment happy-dom
import { getChunks } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { DiffView } from "./DiffView.tsx";

const labels = { label: "Changes", noChanges: "No changes" };
const lines = (changed: Record<number, string> = {}) =>
  Array.from({ length: 30 }, (_, index) => changed[index + 1] ?? `line ${index + 1}`).join("\n");

async function ready() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

describe("DiffView", () => {
  it("finds two chunks for two changed regions, read-only", async () => {
    const page = await mount(
      <DiffView before={lines()} after={lines({ 3: "changed 3", 25: "changed 25" })} labels={labels} />,
    );
    await ready();
    const dom = page.container.querySelector<HTMLElement>(".cm-editor");
    const view = dom ? EditorView.findFromDOM(dom) : null;
    expect(view).not.toBeNull();
    if (!view) return;
    expect(getChunks(view.state)?.chunks).toHaveLength(2);
    expect(view.state.readOnly).toBe(true);
    expect(view.state.doc.toString()).toBe(lines({ 3: "changed 3", 25: "changed 25" }));
    expect(page.container.textContent).not.toContain("No changes");
  });

  it("collapses the long unchanged stretch between the regions", async () => {
    const page = await mount(
      <DiffView before={lines()} after={lines({ 3: "x", 25: "y" })} labels={labels} />,
    );
    await ready();
    expect(page.container.querySelectorAll(".cm-collapsedLines")).toHaveLength(1);
  });

  it("offers no accept or reject buttons: the view only shows", async () => {
    const page = await mount(
      <DiffView before={lines()} after={lines({ 3: "x", 25: "y" })} labels={labels} />,
    );
    await ready();
    expect(page.container.querySelectorAll(".cm-chunkButtons, .cm-deletedChunk button")).toHaveLength(0);
    expect(page.container.querySelector(".cm-deletedChunk")).not.toBeNull();
  });

  it("says No changes and mounts no editor for identical texts", async () => {
    const page = await mount(<DiffView before={lines()} after={lines()} labels={labels} />);
    await ready();
    expect(page.container.textContent).toContain("No changes");
    expect(page.container.querySelector(".cm-editor")).toBeNull();
  });
});
