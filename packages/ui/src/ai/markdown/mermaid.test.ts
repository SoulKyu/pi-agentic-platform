// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  initialize: vi.fn<(config: Record<string, unknown>) => void>(),
  render: vi.fn<(id: string, code: string, container?: Element) => Promise<{ svg: string }>>(),
}));
vi.mock("mermaid", () => ({ default: api }));

beforeEach(() => {
  vi.resetModules();
  api.initialize.mockReset();
  api.render.mockReset().mockResolvedValue({ svg: "<svg></svg>" });
  document.documentElement.removeAttribute("data-theme");
});

const load = () => import("./mermaid.ts");

describe("mermaid.ts", () => {
  it("pins its config", async () => {
    const { drawDiagram } = await load();
    await drawDiagram("d1", "graph TD; A-->B", document.createElement("div"));
    expect(api.initialize).toHaveBeenCalledTimes(1);
    expect(api.initialize.mock.calls[0]?.[0]).toEqual({
      startOnLoad: false,
      securityLevel: "strict",
      maxTextSize: 20_000,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      theme: "neutral",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "themeCSS",
        "themeVariables",
        "fontFamily",
        "altFontFamily",
        "htmlLabels",
        "flowchart",
        "dompurifyConfig",
        "theme",
        "darkMode",
        "look",
      ],
    });
  });

  it("draws with the container it was given and answers the SVG text", async () => {
    api.render.mockResolvedValue({ svg: "<svg>x</svg>" });
    const { drawDiagram } = await load();
    const container = document.createElement("div");
    expect(await drawDiagram("d1", "graph TD; A-->B", container)).toBe("<svg>x</svg>");
    expect(api.render).toHaveBeenCalledWith("d1", "graph TD; A-->B", container);
  });

  it("initialises once for a theme, and again only when the appearance changes", async () => {
    const { drawDiagram } = await load();
    const box = document.createElement("div");
    await drawDiagram("a", "graph TD; A-->B", box);
    await drawDiagram("b", "graph TD; A-->B", box);
    expect(api.initialize).toHaveBeenCalledTimes(1);
    document.documentElement.setAttribute("data-theme", "night");
    await drawDiagram("c", "graph TD; A-->B", box);
    expect(api.initialize).toHaveBeenCalledTimes(2);
    expect(api.initialize.mock.calls[1]?.[0]).toMatchObject({ theme: "dark" });
  });

  it("draws light on the day theme", async () => {
    document.documentElement.setAttribute("data-theme", "day");
    const { drawDiagram } = await load();
    await drawDiagram("a", "graph TD; A-->B", document.createElement("div"));
    expect(api.initialize.mock.calls[0]?.[0]).toMatchObject({ theme: "neutral" });
  });
});
