import { describe, expect, it } from "vitest";
import { katexFonts, woff2Only } from "../vite/katex-fonts.ts";

const face =
  '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Bold.woff2) format("woff2"),url(fonts/KaTeX_Main-Bold.woff) format("woff"),url(fonts/KaTeX_Main-Bold.ttf) format("truetype");font-weight:700}';

describe("katexFonts", () => {
  it("keeps the woff2 entry and drops woff and truetype", () => {
    expect(woff2Only(face)).toBe(
      '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Bold.woff2) format("woff2");font-weight:700}',
    );
  });

  it("transforms KaTeX's stylesheet only", () => {
    const plugin = katexFonts();
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    const id = "/x/node_modules/.pnpm/katex@0.16.47/node_modules/katex/dist/katex.min.css";
    expect(transform(face, id)?.code).not.toContain("truetype");
    expect(transform(face, `${id}?used`)?.code).not.toContain("truetype");
    expect(transform(face, "/x/src/other.css")).toBeNull();
  });
});
