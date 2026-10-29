// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { click, mount } from "../../testing/dom.ts";
import { BoxImage } from "./BoxImage.tsx";
import { RichRepliesContext, type ImageResult, type RichReplies } from "./rich-replies.ts";

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

type Lookup = (src: string, signal?: AbortSignal) => Promise<ImageResult>;

const FORBIDDEN = "iframe, object, embed, video, audio, script";

function setup(result: ImageResult | Promise<ImageResult>) {
  const openFile = vi.fn<(path: string) => void>();
  const rich: RichReplies = { image: () => Promise.resolve(result), openFile, labels };
  return { rich, openFile };
}

const render = (rich: RichReplies | undefined, alt = "a cat", skip = false) => (
  <RichRepliesContext.Provider value={rich}>
    <BoxImage src="cat.png" alt={alt} skip={skip} />
  </RichRepliesContext.Provider>
);

describe("BoxImage", () => {
  it("shows the alt text while it waits", async () => {
    const rich: RichReplies = { image: () => new Promise<ImageResult>(() => undefined), labels };
    const page = await mount(render(rich));
    expect(page.container.textContent).toBe("a cat");
    expect(page.container.querySelector("img")).toBeNull();
  });

  it("an image result renders one <img> with the safe attributes", async () => {
    const page = await mount(render(setup({ kind: "image", url: "/files/raw?path=%2Fw%2Fcat.png" }).rich));
    const img = page.container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/files/raw?path=%2Fw%2Fcat.png");
    expect(img?.getAttribute("alt")).toBe("a cat");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.getAttribute("decoding")).toBe("async");
  });

  it("only <img> is ever rendered, whatever the result", async () => {
    for (const result of [
      { kind: "image", url: "/files/raw?path=x" },
      { kind: "file", path: "/w/data.csv" },
      { kind: "text" },
    ] as const) {
      const page = await mount(render(setup(result).rich));
      expect(page.container.querySelector(FORBIDDEN), result.kind).toBeNull();
      await page.unmount();
    }
  });

  it("a text result is [image: alt]", async () => {
    const page = await mount(render(setup({ kind: "text" }).rich));
    expect(page.container.textContent).toBe("[image: a cat]");
    expect(page.container.querySelector("img")).toBeNull();
  });

  it("a file result is a button that opens the file", async () => {
    const { rich, openFile } = setup({ kind: "file", path: "/w/data.csv" });
    const page = await mount(render(rich));
    const button = page.container.querySelector("button");
    expect(button?.textContent).toBe("a cat");
    expect(button?.getAttribute("aria-label")).toBeNull(); // the name is the visible text
    expect(button?.getAttribute("aria-description")).toBe("Open /w/data.csv");
    await click(button as Element);
    expect(openFile).toHaveBeenCalledWith("/w/data.csv");
  });

  it("without richReplies the image is [image: alt]", async () => {
    const page = await mount(render(undefined));
    expect(page.container.textContent).toBe("[image: a cat]");
  });

  it("a rejected lookup is [image: alt]", async () => {
    const rich: RichReplies = { image: () => Promise.reject(new Error("net")), labels };
    const page = await mount(render(rich));
    expect(page.container.textContent).toBe("[image: a cat]");
  });

  it("an empty alt shows the source as text, in every state", async () => {
    const pending: RichReplies = { image: () => new Promise<ImageResult>(() => undefined), labels };
    expect((await mount(render(pending, ""))).container.textContent).toBe("cat.png");
    expect((await mount(render(setup({ kind: "text" }).rich, ""))).container.textContent).toBe(
      "[image: cat.png]",
    );
    const file = setup({ kind: "file", path: "/w/cat.png" }).rich;
    const button = (await mount(render(file, ""))).container.querySelector("button");
    expect(button?.textContent).toBe("/w/cat.png");
    expect(button?.getAttribute("aria-label")).toBeNull();
  });

  it("a skipped image (past the cap) is [image: alt] and never looks anything up", async () => {
    const image = vi.fn<Lookup>(() => Promise.resolve({ kind: "image", url: "/x" }));
    const page = await mount(render({ image, labels }, "a cat", true));
    expect(page.container.textContent).toBe("[image: a cat]");
    expect(image).not.toHaveBeenCalled();
  });

  it("the lookup is aborted when the image unmounts", async () => {
    let signal: AbortSignal | undefined;
    const image: Lookup = (_src, given) => {
      signal = given;
      return new Promise<ImageResult>(() => undefined);
    };
    const page = await mount(render({ image, labels }));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await page.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
