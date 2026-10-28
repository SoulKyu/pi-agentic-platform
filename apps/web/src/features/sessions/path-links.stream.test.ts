import { describe, expect, it } from "vitest";
import type { PathScope } from "../../stores/reply-ports.ts";
import { findPaths } from "./path-links.ts";

const scope: PathScope = { base: "/w/p", roots: ["/w/p"], filesRoot: "/w/p", agentId: null };
const reply =
  "Edit src/app.py:12:5 and then (see README.md), or /w/p/lib/b.ts:7. Done with https://x.org/a.ts here.";

describe("findPaths while a reply streams", () => {
  it("every prefix yields spans that end inside the prefix, and the whole text yields exactly these spans", () => {
    for (let end = 0; end <= reply.length; end += 1) {
      const prefix = reply.slice(0, end);
      let previousEnd = 0;
      for (const span of findPaths(prefix, scope)) {
        expect(prefix.slice(span.start, span.end)).toBe(span.text);
        expect(span.start).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = span.end;
      }
    }
    expect(findPaths(reply, scope).map(({ text, path, line }) => ({ text, path, line }))).toEqual([
      { text: "src/app.py:12:5", path: "/w/p/src/app.py", line: 12 },
      { text: "README.md", path: "/w/p/README.md", line: null },
      { text: "/w/p/lib/b.ts:7", path: "/w/p/lib/b.ts", line: 7 },
    ]);
  });

  it("a :line that grows keeps its start, so the React key stays", () => {
    const starts = ["see src/a.ts:1", "see src/a.ts:12", "see src/a.ts:123"].map(
      (text) => findPaths(text, scope)[0]?.start,
    );
    expect(starts).toEqual([4, 4, 4]);
  });

  it("a URL typed character by character never links", () => {
    const url = "https://example.org/docs/a.ts:12";
    for (let end = 1; end <= url.length; end += 1) {
      expect(findPaths(`see ${url.slice(0, end)}`, scope), url.slice(0, end)).toEqual([]);
    }
  });
});
