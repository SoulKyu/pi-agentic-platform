// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import { MathBlock, MAX_TEX_CHARS } from "./MathBlock.tsx";
import { RichRepliesContext, type RichReplies } from "./rich-replies.ts";

const mocked = vi.hoisted(() => ({ fail: false }));
vi.mock("./math.ts", () => ({
  renderTex(tex: string, display: boolean): string {
    if (mocked.fail) throw new Error("no katex");
    return `<span class="katex" data-display="${String(display)}">${tex}</span>`;
  },
}));

/** The block's lazy import has resolved (the mocked module is loaded) and React has applied what followed. */
const loaded = async () => {
  await import("./math.ts");
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const labels: RichReplies["labels"] = {
  image: (alt) => alt,
  openFile: (path) => path,
  preview: "",
  hide: "",
  artifactFrame: "",
  artifactTitle: "",
  mermaidError: "",
  mermaidTooLarge: "",
  diagram: "",
};

describe("MathBlock", () => {
  it("renders KaTeX's output once math.ts has loaded", async () => {
    const page = await mount(<MathBlock tex="x^2" display={false} />);
    await loaded();
    const out = page.container.querySelector(".katex");
    expect(out?.textContent).toBe("x^2");
    expect(out?.getAttribute("data-display")).toBe("false");
  });

  it("shows the source while it waits", async () => {
    const page = await mount(<MathBlock tex="a+b" display />);
    expect(page.container.textContent).toBe("a+b");
  });

  it("source over 10 000 characters stays text", async () => {
    const tex = "x".repeat(MAX_TEX_CHARS + 1);
    const page = await mount(<MathBlock tex={tex} display />);
    await loaded();
    expect(page.container.querySelector(".katex")).toBeNull();
    expect(page.container.textContent).toBe(tex);
  });

  it("source of exactly 10 000 characters is rendered", async () => {
    const page = await mount(<MathBlock tex={"x".repeat(MAX_TEX_CHARS)} display />);
    await loaded();
    expect(page.container.querySelector(".katex")).not.toBeNull();
  });

  it("a loading failure keeps the source and reports it", async () => {
    const onLoadError = vi.fn<() => void>();
    mocked.fail = true;
    try {
      const page = await mount(
        <RichRepliesContext.Provider value={{ labels, onLoadError }}>
          <MathBlock tex="y" display={false} />
        </RichRepliesContext.Provider>,
      );
      await loaded();
      expect(page.container.querySelector(".katex")).toBeNull();
      expect(page.container.textContent).toBe("y");
      expect(onLoadError).toHaveBeenCalledOnce();
    } finally {
      mocked.fail = false;
    }
  });

  it("a math block carries the containment class", async () => {
    const display = await mount(<MathBlock tex="a" display />);
    await loaded();
    const block = display.container.firstElementChild;
    expect(block?.classList.contains("contain-rich")).toBe(true);
    expect(block?.contains(display.container.querySelector(".katex"))).toBe(true);
    const inline = await mount(<MathBlock tex="b" display={false} />);
    await loaded();
    const span = inline.container.firstElementChild;
    expect(span?.classList.contains("contain-rich-inline")).toBe(true);
    expect(span?.classList.contains("contain-rich")).toBe(false);
  });

  // KaTeX does not cap a negative size (`\raisebox{-15em}{x}`, `\kern-30em`, a size built by a macro): the paint
  // containment of the box is what keeps every formula, whatever it draws, inside it (UX2-R81). So no path escapes it.
  it.each([
    ["display, rendered", "a", true, false, false],
    ["inline, rendered", "a", false, false, false],
    ["display, loading", "a", true, false, true],
    ["inline, loading", "a", false, false, true],
    ["display, too long", "x".repeat(MAX_TEX_CHARS + 1), true, false, false],
    ["inline, too long", "x".repeat(MAX_TEX_CHARS + 1), false, false, false],
    ["display, failed", "a", true, true, false],
    ["inline, failed", "a", false, true, false],
  ] as const)("every path is contained: %s", async (_name, tex, display, fail, beforeLoad) => {
    mocked.fail = fail;
    try {
      const page = await mount(<MathBlock tex={tex} display={display} />);
      if (!beforeLoad) await loaded();
      const box = page.container.firstElementChild;
      expect(box?.classList.contains(display ? "contain-rich" : "contain-rich-inline")).toBe(true);
    } finally {
      mocked.fail = false;
    }
  });
});
