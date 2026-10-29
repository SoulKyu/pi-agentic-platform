// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { RichRepliesContext, type RichReplies } from "./rich-replies.ts";

// Mermaid's lazy chunk "fails to load" (an update renamed it while the page stayed open).
vi.mock("./highlight.ts", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("./mermaid.ts", () => {
  throw new Error("chunk gone");
});

const onLoadError = vi.fn<() => void>();
const rich: RichReplies = {
  onLoadError,
  labels: {
    image: (alt) => alt,
    openFile: (path) => path,
    preview: "Preview",
    hide: "Hide",
    artifactFrame: "f",
    artifactTitle: "t",
    mermaidError: "This diagram could not be drawn.",
    mermaidTooLarge: "large",
    diagram: "Diagram",
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  onLoadError.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("MermaidBlock when its chunk fails to load", () => {
  it("reports it once, keeps the source and shows the error line", async () => {
    const page = await mount(
      <RichRepliesContext.Provider value={rich}>
        <MermaidBlock code="graph TD; A-->B" />
      </RichRepliesContext.Provider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(page.container.textContent).toContain("graph TD; A-->B");
    expect(page.container.textContent).toContain("This diagram could not be drawn.");
    expect(page.container.querySelector("img")).toBeNull();
  });
});
