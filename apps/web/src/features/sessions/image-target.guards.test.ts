import { describe, expect, it, vi } from "vitest";
import type { PathScope } from "../../stores/reply-ports.ts";

// A path judge that accepts every string whole: what is left refused is the image rules' own doing (defence in depth).
vi.mock("./path-links.ts", () => ({
  findPaths: (text: string) => [{ start: 0, end: text.length, text, path: `/w/p/${text}.png`, line: null }],
}));
const { imageTarget } = await import("./image-target.ts");

const scope: PathScope = { base: "/w/p", roots: ["/w/p"], filesRoot: "/w/p", agentId: null };

describe("imageTarget's own rules, whatever the path judge says", () => {
  it.each([
    "https://x/a",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "//x/a",
    "a?x=1",
    "a#frag",
    "a%3Fx",
    "%zz",
  ])("refuses %j", (src) => {
    expect(imageTarget(src, scope)).toBeNull();
  });

  it("a plain name still resolves", () => {
    expect(imageTarget("a", scope)).toEqual({ kind: "image", path: "/w/p/a.png" });
  });

  it("a span with a line, or not covering the whole string, is refused", async () => {
    const links = await import("./path-links.ts");
    const judge = vi.spyOn(links, "findPaths");
    judge.mockReturnValueOnce([{ start: 0, end: 1, text: "a", path: "/w/p/a.png", line: 3 }]);
    expect(imageTarget("a", scope)).toBeNull();
    judge.mockReturnValueOnce([{ start: 1, end: 2, text: "b", path: "/w/p/b.png", line: null }]);
    expect(imageTarget("ab", scope)).toBeNull();
    judge.mockReturnValueOnce([]);
    expect(imageTarget("a", scope)).toBeNull();
  });
});
