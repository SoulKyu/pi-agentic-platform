// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { button, click, mount } from "../../testing/dom.ts";
import { HtmlFence } from "./HtmlFence.tsx";
import { RichRepliesContext, type RichReplies } from "./rich-replies.ts";

const labels: RichReplies["labels"] = {
  image: (alt) => alt,
  openFile: (path) => path,
  preview: "Preview",
  hide: "Hide",
  artifactFrame: "UNTRUSTED · html from the reply",
  artifactTitle: "HTML preview",
  mermaidError: "e",
  mermaidTooLarge: "l",
  diagram: "Diagram",
};
vi.mock("./highlight.ts", () => ({ highlightCode: () => Promise.resolve(null) }));
const copy = { copy: "Copy", copied: "Copied" };
const URL_A = "https://p.example:7778/a/TOKEN/";

const view = (rich: RichReplies | undefined, offset: number | null = 12) => (
  <RichRepliesContext.Provider value={rich}>
    <HtmlFence code="<h1>hi</h1>" lang="html" labels={copy} offset={offset} />
  </RichRepliesContext.Provider>
);
// happy-dom would fetch the frame's `src`: a test never reaches the network.
beforeEach(() => {
  (
    window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
  ).happyDOM.settings.disableIframePageLoading = true;
});

const settle = () => act(async () => {});
const withArtifact = (
  artifact: RichReplies["artifact"],
  canArtifact: RichReplies["canArtifact"] = () => true,
) => ({ labels, artifact, canArtifact }) satisfies RichReplies;

describe("HtmlFence", () => {
  it("shows the code and no PREVIEW without an artifact function", async () => {
    const page = await mount(view({ labels }));
    expect(page.container.textContent).toContain("<h1>hi</h1>");
    expect(() => button(page.container, "Preview")).toThrow();
    expect(page.container.querySelector("iframe")).toBeNull();
  });

  it("shows no PREVIEW when the app says the fence has no artifact (not top-level)", async () => {
    const artifact = vi.fn(() => Promise.resolve(URL_A));
    const page = await mount(view(withArtifact(artifact, () => false)));
    expect(() => button(page.container, "Preview")).toThrow();
    const none = await mount(view(withArtifact(artifact), null));
    expect(() => button(none.container, "Preview")).toThrow();
    expect(artifact).not.toHaveBeenCalled();
  });

  it("asks canArtifact with the offset and the code it shows", async () => {
    const canArtifact = vi.fn<NonNullable<RichReplies["canArtifact"]>>(() => true);
    await mount(view(withArtifact(() => Promise.resolve(URL_A), canArtifact)));
    expect(canArtifact).toHaveBeenCalledWith(12, "<h1>hi</h1>");
  });

  it("PREVIEW mints once and shows the sandboxed frame; HIDE removes it", async () => {
    const artifact = vi.fn<(offset: number) => Promise<string>>(() => Promise.resolve(URL_A));
    const page = await mount(view(withArtifact(artifact)));
    await click(button(page.container, "Preview"));
    await settle();
    expect(artifact).toHaveBeenCalledTimes(1);
    expect(artifact).toHaveBeenCalledWith(12, "<h1>hi</h1>");
    const frame = page.container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(URL_A);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("title")).toBe("HTML preview");
    expect(frame.className.split(" ")).toContain("max-h-artifact");
    const caption = page.container.querySelector("figcaption") as HTMLElement;
    expect(caption.textContent).toBe("UNTRUSTED · html from the reply");
    expect(frame.contains(caption)).toBe(false);
    await click(button(page.container, "Hide"));
    expect(page.container.querySelector("iframe")).toBeNull();
    expect(artifact).toHaveBeenCalledTimes(1);
    await click(button(page.container, "Preview"));
    await settle();
    expect(artifact).toHaveBeenCalledTimes(2);
  });

  it("a failure shows an InlineError with the app's text and no frame", async () => {
    const artifact = vi.fn(() => Promise.reject(new Error("Too many previews are open.")));
    const page = await mount(view(withArtifact(artifact)));
    await click(button(page.container, "Preview"));
    await settle();
    expect(page.container.querySelector("iframe")).toBeNull();
    expect(page.container.querySelector('[data-slot="inline-error"]')?.textContent).toContain(
      "Too many previews are open.",
    );
  });

  it("HIDE during a pending mint drops the answer", async () => {
    let answer: (url: string) => void = () => undefined;
    const artifact = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    const page = await mount(view(withArtifact(artifact)));
    await click(button(page.container, "Preview"));
    await click(button(page.container, "Hide"));
    await act(async () => answer(URL_A));
    expect(page.container.querySelector("iframe")).toBeNull();
  });
});
