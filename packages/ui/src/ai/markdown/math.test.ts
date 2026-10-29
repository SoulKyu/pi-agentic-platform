import { describe, expect, it } from "vitest";
import { MAX_TEX_CHARS } from "./MathBlock.tsx";
import { renderTex } from "./math.ts";

/** The formula as drawn: KaTeX also keeps the TeX source in the MathML annotation, which is not a size. */
const drawn = (out: string) => out.replace(/<annotation[\s\S]*?<\/annotation>/u, "");

describe("renderTex (real KaTeX)", () => {
  it("renders a formula as KaTeX markup with its MathML", () => {
    const out = renderTex("x^2", false);
    expect(out).toContain('class="katex"');
    expect(out).toContain("<math");
  });

  it("display mode wraps the formula in katex-display", () => {
    expect(renderTex("x", true)).toContain("katex-display");
    expect(renderTex("x", false)).not.toContain("katex-display");
  });

  it("\\rule{20em}{20em} renders no size above 2em", () => {
    const out = drawn(renderTex("\\rule{20em}{20em}", false));
    expect(out).not.toContain("20em");
    expect(out).toContain("2em");
  });

  it("\\href and \\htmlStyle stay text with trust off", () => {
    const href = renderTex("\\href{https://e.test/}{click}", false);
    expect(href).not.toMatch(/<a[\s>]/);
    expect(href).not.toContain('href="');
    expect(drawn(href)).toContain("\\href");
    const style = renderTex("\\htmlStyle{position: fixed; top: 0}{x}", false);
    expect(drawn(style)).not.toMatch(/position:\s*fixed/);
    expect(drawn(style)).toContain("\\htmlStyle");
  });

  it("\\url, \\htmlClass, \\htmlData and \\includegraphics stay text too", () => {
    for (const tex of [
      "\\url{https://e.test/}",
      "\\htmlClass{evil}{x}",
      "\\htmlData{a=b}{x}",
      "\\includegraphics{https://e.test/a.png}",
    ]) {
      const out = renderTex(tex, false);
      expect(drawn(out), tex).toContain(tex.slice(0, tex.indexOf("{")));
      expect(out, tex).not.toMatch(/<a[\s>]|<img|class="evil"|data-a=/);
    }
  });

  it("a broken formula is shown as its source, not thrown", () => {
    expect(renderTex("\\frac{", false)).toContain("katex-error");
  });

  it("the limit on the TeX length is 10 000 characters", () => {
    expect(MAX_TEX_CHARS).toBe(10_000);
  });
});
