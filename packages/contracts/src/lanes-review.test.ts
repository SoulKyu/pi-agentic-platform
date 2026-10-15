import { describe, expect, it } from "vitest";
import { ReviewDoc } from "./lanes-review.ts";

const comment = {
  id: "c1",
  path: "src/a.ts",
  side: "after",
  line: 3,
  excerpt: "x",
  body: "why?",
  createdAt: 1,
  sentAt: null,
  resolvedAt: null,
};

describe("ReviewDoc", () => {
  it("keeps a path named __proto__ as data", () => {
    const doc = ReviewDoc.parse(
      JSON.parse('{"seen":[{"path":"__proto__","identity":"deleted"}],"comments":[]}'),
    );
    expect(doc.seen[0]?.path).toBe("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Array.isArray(doc.seen)).toBe(true);
  });
  it("refuses a blank comment body and 501 comments", () => {
    expect(ReviewDoc.safeParse({ seen: [], comments: [{ ...comment, body: "   " }] }).success).toBe(false);
    expect(ReviewDoc.safeParse({ seen: [], comments: [comment] }).success).toBe(true);
    expect(ReviewDoc.safeParse({ seen: [], comments: Array(501).fill(comment) }).success).toBe(false);
  });
});
