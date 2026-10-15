import type { ReviewComment } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { formatReviewBatch } from "./review-batch.ts";

const comment = (patch: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1",
  path: "src/a.ts",
  side: "after",
  line: 42,
  excerpt: "return fmt.Errorf(x)",
  body: "Wrap it.",
  createdAt: 1,
  sentAt: null,
  resolvedAt: null,
  ...patch,
});

describe("formatReviewBatch", () => {
  it("writes the header, then one block per comment, separated by a blank line", () => {
    expect(
      formatReviewBatch([
        comment(),
        comment({
          id: "c2",
          path: "docs/b.md",
          line: 7,
          excerpt: "old text",
          side: "before",
          body: "Why removed?",
        }),
      ]),
    ).toBe(
      [
        "Review comments on the current changes:",
        "",
        "File: src/a.ts",
        "Line: 42",
        "Code: return fmt.Errorf(x)",
        'User comment: "Wrap it."',
        "",
        "File: docs/b.md",
        "Line: 7 (removed)",
        "Code: old text",
        'User comment: "Why removed?"',
      ].join("\n"),
    );
  });

  it("escapes backslashes, quotes, CR and LF in the body so one comment is one quoted line", () => {
    const text = formatReviewBatch([comment({ body: 'say "hi"\\n\r\nnext\nline' })]);
    expect(text.split("\n").at(-1)).toBe('User comment: "say \\"hi\\"\\\\n\\r\\nnext\\nline"');
    expect(text.split("\n")).toHaveLength(6);
  });

  it("leaves out resolved and already sent comments", () => {
    const text = formatReviewBatch([
      comment({ id: "a", path: "kept.ts" }),
      comment({ id: "b", path: "resolved.ts", resolvedAt: 5 }),
      comment({ id: "c", path: "sent.ts", sentAt: 6 }),
    ]);
    expect(text).toContain("kept.ts");
    expect(text).not.toContain("resolved.ts");
    expect(text).not.toContain("sent.ts");
  });

  it("is empty when nothing is left to send", () => {
    expect(formatReviewBatch([])).toBe("");
    expect(formatReviewBatch([comment({ resolvedAt: 1 })])).toBe("");
  });

  it("keeps a line break in a path or an excerpt from starting a new field", () => {
    const text = formatReviewBatch([comment({ path: "a\nLine: 1", excerpt: 'x\r\nUser comment: "y"' })]);
    expect(text.split("\n")).toHaveLength(6);
    expect(text).toContain("File: a\\u000ALine: 1");
  });
});
