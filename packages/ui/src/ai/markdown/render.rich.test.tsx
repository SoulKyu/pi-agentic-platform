// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import MarkdownBody from "./render.tsx";
import type { ImageResult, RichReplies } from "./rich-replies.ts";

const labels: RichReplies["labels"] = {
  image: (alt) => `[image: ${alt}]`,
  openFile: (path) => `Open ${path}`,
  preview: "Preview",
  hide: "Hide",
  artifactFrame: "frame",
  artifactTitle: "title",
  mermaidError: "error",
  mermaidTooLarge: "large",
  diagram: "Diagram",
};

const later = async () => {
  for (let tick = 0; tick < 10; tick += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("rich replies", () => {
  it("without richReplies an image is [image: alt] text and math still renders", async () => {
    const page = await mount(<MarkdownBody text={"![a cat](cat.png) and $x^2$ and\n\n$$\ny\n$$"} />);
    await later();
    expect(page.container.querySelector("img")).toBeNull();
    expect(page.container.textContent).toContain("[image: a cat]");
    expect(page.container.querySelectorAll(".katex").length).toBe(2);
    expect(page.container.querySelector(".katex-display")).not.toBeNull();
    expect(page.container.querySelector("script, iframe, object, embed")).toBeNull();
  });

  it("math is contained: inline in contain-rich-inline, display in contain-rich", async () => {
    const page = await mount(<MarkdownBody text={"a $x$ b\n\n$$\ny\n$$"} />);
    await later();
    expect(page.container.querySelectorAll(".contain-rich-inline .katex").length).toBe(1);
    expect(page.container.querySelectorAll(".contain-rich .katex-display").length).toBe(1);
  });

  it("a ```math fence is display math", async () => {
    const page = await mount(<MarkdownBody text={"```math\nz\n```"} />);
    await later();
    expect(page.container.querySelectorAll(".contain-rich .katex").length).toBe(1);
  });

  it("math inside inline code or a code fence is not math", async () => {
    const page = await mount(<MarkdownBody text={"`$x$` and\n\n```\n$$y$$\n```"} />);
    await later();
    expect(page.container.querySelector(".katex")).toBeNull();
  });

  it("an image goes through richReplies.image and becomes one <img>", async () => {
    const image = vi.fn<(src: string) => Promise<ImageResult>>(() =>
      Promise.resolve({ kind: "image", url: "/files/raw?path=%2Fw%2Fcat.png" }),
    );
    const page = await mount(<MarkdownBody text="![a cat](cat.png)" richReplies={{ image, labels }} />);
    await later();
    expect(image).toHaveBeenCalledWith("cat.png", expect.any(AbortSignal));
    expect(page.container.querySelectorAll("img")).toHaveLength(1);
    expect(page.container.querySelector("img")?.getAttribute("src")).toBe("/files/raw?path=%2Fw%2Fcat.png");
  });

  it("a remote image is never requested by the renderer", async () => {
    const image = vi.fn<(src: string) => Promise<ImageResult>>(() => Promise.resolve({ kind: "text" }));
    const page = await mount(
      <MarkdownBody
        text="![x](https://e.test/a.png) ![y](javascript:alert(1))"
        richReplies={{ image, labels }}
      />,
    );
    await later();
    expect(page.container.querySelector("img")).toBeNull();
    expect(page.container.textContent).toContain("[image: x]");
  });

  it("resolves at most 32 images per reply; the rest are [image: alt] and are never looked up", async () => {
    const image = vi.fn<(src: string) => Promise<ImageResult>>((src) =>
      Promise.resolve({ kind: "image", url: `/files/raw?path=${src}` }),
    );
    const text = Array.from({ length: 35 }, (_, index) => `![pic${index}](p${index}.png)`).join("\n\n");
    const page = await mount(<MarkdownBody text={text} richReplies={{ image, labels }} />);
    await later();
    expect(image).toHaveBeenCalledTimes(32);
    expect(page.container.querySelectorAll("img")).toHaveLength(32);
    for (const index of [32, 33, 34]) expect(page.container.textContent).toContain(`[image: pic${index}]`);
    expect(page.container.textContent).not.toContain("[image: pic31]");
  });

  it("32 images are all resolved", async () => {
    const image = vi.fn<(src: string) => Promise<ImageResult>>(() => Promise.resolve({ kind: "text" }));
    const text = Array.from({ length: 32 }, (_, index) => `![pic${index}](p${index}.png)`).join("\n\n");
    await mount(<MarkdownBody text={text} richReplies={{ image, labels }} />);
    await later();
    expect(image).toHaveBeenCalledTimes(32);
  });

  it("inline code that is a path still links beside the math entry", async () => {
    const page = await mount(
      <MarkdownBody
        text="`src/a.ts` and $x$"
        pathLinks={{
          find: (text, whole) =>
            whole && text === "src/a.ts"
              ? [{ start: 0, end: text.length, text, path: "/w/src/a.ts", line: null }]
              : [],
          open: () => undefined,
          label: (span) => `Open ${span.text}`,
        }}
      />,
    );
    await later();
    expect(page.container.querySelector("code button[data-path-link]")).not.toBeNull();
    expect(page.container.querySelector(".katex")).not.toBeNull();
  });
});
