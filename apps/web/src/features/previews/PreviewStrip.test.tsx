// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { button, mount } from "../../testing/dom.ts";
import { AGENT_BOX, previewView, PROJECT_BOX, PROJECT_ID } from "../../testing/previews-fixtures.ts";
import { PreviewStrip } from "./PreviewStrip.tsx";

const seed = (...services: ReturnType<typeof previewView>[]) =>
  usePreviewsStore.getState().apply({ type: "snapshot", services });
beforeEach(() => usePreviewsStore.getState().reset());

describe("PreviewStrip", () => {
  it("draws one polite line per running service of the box", async () => {
    seed(
      previewView({ name: "web", port: 8000, id: "1".repeat(32) }),
      previewView({ name: "api", port: 9000, id: "2".repeat(32) }),
    );
    const page = await mount(<PreviewStrip box={PROJECT_BOX} onOpen={() => {}} />);
    const lines = [...page.container.querySelectorAll("[data-preview-line]")];
    expect(lines.map((line) => line.textContent)).toEqual([
      "Preview api · port 9000Open preview",
      "Preview web · port 8000Open preview",
    ]);
    expect(page.container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("draws nothing for a failed service, for another box's service, or before the stream is ready", async () => {
    usePreviewsStore.setState({
      services: new Map([
        ["a", previewView({ name: "dead", state: "failed", reason: "exited" })],
        ["b", previewView({ name: "theirs", box: AGENT_BOX })],
      ]),
      ready: true,
    });
    const page = await mount(<PreviewStrip box={PROJECT_BOX} onOpen={() => {}} />);
    expect(page.container.querySelector("[data-preview-line]")).toBeNull();
    act(() => usePreviewsStore.setState({ services: new Map([["c", previewView()]]), ready: false }));
    expect(page.container.querySelector("[data-preview-line]")).toBeNull();
  });

  it("OPEN PREVIEW hands the preview item of that service to the opener", async () => {
    seed(previewView({ name: "web" }));
    const onOpen = vi.fn();
    const page = await mount(<PreviewStrip box={PROJECT_BOX} onOpen={onOpen} />);
    await act(async () => button(page.container, "Open preview").click());
    expect(onOpen).toHaveBeenCalledWith({ kind: "preview", box: `project:${PROJECT_ID}`, name: "web" });
  });
});
