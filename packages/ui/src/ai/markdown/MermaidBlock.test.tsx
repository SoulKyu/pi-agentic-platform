// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import { MAX_DIAGRAM_CHARS } from "./diagram-size.ts";
import { MermaidBlock } from "./MermaidBlock.tsx";
import { RichRepliesContext, type RichReplies } from "./rich-replies.ts";

const draw = vi.hoisted(() => ({
  fn: vi.fn<(id: string, code: string, container: Element) => Promise<string>>(),
}));
vi.mock("./highlight.ts", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("./mermaid.ts", () => ({
  drawDiagram: (id: string, code: string, container: Element) => draw.fn(id, code, container),
}));

const labels: RichReplies["labels"] = {
  image: (alt) => alt,
  openFile: (path) => path,
  preview: "Preview",
  hide: "Hide",
  artifactFrame: "frame",
  artifactTitle: "title",
  mermaidError: "This diagram could not be drawn.",
  mermaidTooLarge: "This diagram is too large to draw here.",
  diagram: "Diagram",
};
const rich: RichReplies = { labels };

const HOSTILE =
  '<svg xmlns="http://www.w3.org/2000/svg"><style>#x{position:fixed;inset:0}</style>' +
  '<foreignObject><form action="/x"><button>Allow once</button></form></foreignObject></svg>';

beforeEach(() => {
  vi.useFakeTimers();
  draw.fn.mockReset().mockResolvedValue(HOSTILE);
  vi.spyOn(URL, "createObjectURL");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const view = (code: string) => (
  <RichRepliesContext.Provider value={rich}>
    <MermaidBlock code={code} />
  </RichRepliesContext.Provider>
);
const quiet = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("MermaidBlock", () => {
  it("shows the source and waits for 400 ms of quiet before drawing", async () => {
    const page = await mount(view("graph TD; A-->B"));
    expect(page.container.textContent).toContain("graph TD; A-->B");
    await quiet(399);
    expect(draw.fn).not.toHaveBeenCalled();
    await quiet(1);
    expect(draw.fn).toHaveBeenCalledTimes(1);
  });

  it("a change restarts the quiet period", async () => {
    const page = await mount(view("graph TD; A-->B"));
    await quiet(300);
    await page.rerender(view("graph TD; A-->C"));
    await quiet(300);
    expect(draw.fn).not.toHaveBeenCalled();
    await quiet(100);
    expect(draw.fn).toHaveBeenCalledTimes(1);
    expect(draw.fn.mock.calls[0]?.[1]).toBe("graph TD; A-->C");
  });

  const svgOf = (src: string | null | undefined) => {
    const [head, data = ""] = (src ?? "").split(",");
    expect(head).toBe("data:image/svg+xml;base64");
    return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  };

  it("renders only an <img> whose src is a data: URL of the SVG, never a blob: URL", async () => {
    const page = await mount(view("graph TD; A-->B"));
    await quiet(400);
    const box = page.container.querySelector("[data-diagram]") as HTMLElement;
    const images = box.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(svgOf(images[0]?.getAttribute("src"))).toBe(HOSTILE);
    expect(images[0]?.getAttribute("alt")).toBe("Diagram");
    expect(images[0]?.getAttribute("decoding")).toBe("async");
    expect(page.container.querySelector("style, form, foreignObject, svg, button[type=submit]")).toBeNull();
    expect(page.container.innerHTML).not.toContain("Allow once");
    expect(page.container.innerHTML).not.toContain("blob:");
    expect(box.className.split(" ")).toContain("contain-rich");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("keeps non-ASCII labels intact", async () => {
    draw.fn.mockResolvedValue("<svg>é — 图</svg>");
    const page = await mount(view("graph TD; A-->B"));
    await quiet(400);
    expect(svgOf(page.container.querySelector("img")?.getAttribute("src"))).toBe("<svg>é — 图</svg>");
  });

  it("a redraw swaps the image for the new diagram's", async () => {
    draw.fn.mockResolvedValueOnce("<svg>one</svg>").mockResolvedValueOnce("<svg>two</svg>");
    const page = await mount(view("graph TD; A-->B"));
    await quiet(400);
    await page.rerender(view("graph TD; A-->C"));
    await quiet(400);
    expect(svgOf(page.container.querySelector("img")?.getAttribute("src"))).toBe("<svg>two</svg>");
  });

  it("renders into its own contained container", async () => {
    const page = await mount(view("graph TD; A-->B"));
    await quiet(400);
    const container = draw.fn.mock.calls[0]?.[2] as HTMLElement;
    const box = page.container.querySelector("[data-diagram]") as HTMLElement;
    expect(box.contains(container)).toBe(true);
    expect(container.closest(".contain-rich")).toBe(box);
    expect(container.childElementCount).toBe(0);
  });

  it("a syntax error keeps the source and shows the error line", async () => {
    draw.fn.mockRejectedValue(new Error("Parse error"));
    const page = await mount(view("graph TD; A-->"));
    await quiet(400);
    expect(page.container.querySelector("img")).toBeNull();
    expect(page.container.textContent).toContain("graph TD; A-->");
    expect(page.container.textContent).toContain("This diagram could not be drawn.");
    expect(page.container.textContent).not.toContain("Parse error");
  });

  it("over 20 000 characters never calls render and says so", async () => {
    const code = `graph TD; ${"A-->B;".repeat(Math.ceil(MAX_DIAGRAM_CHARS / 6))}`;
    expect(code.length).toBeGreaterThan(MAX_DIAGRAM_CHARS);
    const page = await mount(view(code));
    await quiet(2000);
    expect(draw.fn).not.toHaveBeenCalled();
    expect(page.container.textContent).toContain("This diagram is too large to draw here.");
    expect(page.container.querySelector("img")).toBeNull();
  });

  it("a draw that finishes after a newer change is dropped", async () => {
    let finish: (svg: string) => void = () => undefined;
    draw.fn.mockImplementationOnce(() => new Promise<string>((resolve) => (finish = resolve)));
    const page = await mount(view("graph TD; A-->B"));
    await quiet(400);
    await page.rerender(view("graph TD; A-->C"));
    await act(async () => finish("<svg></svg>"));
    expect(page.container.querySelector("img")).toBeNull();
  });
});
