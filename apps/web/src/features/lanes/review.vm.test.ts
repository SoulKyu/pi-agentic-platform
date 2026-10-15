import type { ReviewComment, ReviewDoc } from "@pap/contracts";
import type { ReviewFile } from "./review-types.ts";
import { describe, expect, it } from "vitest";
import {
  addComment,
  deleteComment,
  editComment,
  excerptOf,
  isSeen,
  markSent,
  orderFiles,
  progressOf,
  readyToSend,
  resolveComment,
  setSeen,
  turnPreview,
} from "./review.vm.ts";

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);
const file = (path: string, patch: Partial<ReviewFile> = {}): ReviewFile => ({
  path,
  oldPath: null,
  status: "M",
  additions: 1,
  deletions: 0,
  binary: false,
  identity: BLOB_A,
  ...patch,
});
const comment = (id: string, patch: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  path: "a.ts",
  side: "after",
  line: 1,
  excerpt: "x",
  body: "b",
  createdAt: 1,
  sentAt: null,
  resolvedAt: null,
  ...patch,
});
const EMPTY: ReviewDoc = { seen: [], comments: [] };

describe("review list", () => {
  it("orders files by path, without changing the list it was given", () => {
    const files = [file("b/z.ts"), file("a.ts"), file("b/a.ts")];
    expect(orderFiles(files).map((entry) => entry.path)).toEqual(["a.ts", "b/a.ts", "b/z.ts"]);
    expect(files.map((entry) => entry.path)).toEqual(["b/z.ts", "a.ts", "b/a.ts"]);
  });

  it("counts Seen files by path and identity, and a changed identity shows unticked", () => {
    const files = [file("a.ts"), file("b.ts", { identity: BLOB_B }), file("c.ts")];
    const doc: ReviewDoc = {
      seen: [
        { path: "a.ts", identity: BLOB_A },
        { path: "b.ts", identity: BLOB_A },
        { path: "gone.ts", identity: BLOB_A },
      ],
      comments: [comment("1"), comment("2", { resolvedAt: 9 })],
    };
    expect(isSeen(doc, files[0] as ReviewFile)).toBe(true);
    expect(isSeen(doc, files[1] as ReviewFile)).toBe(false);
    expect(progressOf(doc, files)).toEqual({ seen: 1, total: 3, comments: 1 });
  });

  it("ticks and unticks a file, replacing an older identity of the same path", () => {
    const a = file("a.ts");
    const ticked = setSeen(EMPTY, a, true);
    expect(ticked.seen).toEqual([{ path: "a.ts", identity: BLOB_A }]);
    const moved = setSeen(ticked, file("a.ts", { identity: BLOB_B }), true);
    expect(moved.seen).toEqual([{ path: "a.ts", identity: BLOB_B }]);
    expect(setSeen(moved, file("a.ts", { identity: BLOB_B }), false).seen).toEqual([]);
  });

  it("keeps a path named __proto__ as data", () => {
    const doc = setSeen(EMPTY, file("__proto__"), true);
    expect(doc.seen).toEqual([{ path: "__proto__", identity: BLOB_A }]);
    expect(isSeen(doc, file("__proto__"))).toBe(true);
  });

  it("drops the oldest Seen entries past the contract's cap", () => {
    const full: ReviewDoc = {
      seen: Array.from({ length: 2000 }, (_, index) => ({ path: `f${index}`, identity: BLOB_A })),
      comments: [],
    };
    const next = setSeen(full, file("new.ts"), true);
    expect(next.seen).toHaveLength(2000);
    expect(next.seen.at(-1)?.path).toBe("new.ts");
    expect(next.seen[0]?.path).toBe("f1");
  });

  it("shows a turn's preview with hidden characters written out", () => {
    expect(turnPreview({ preview: "fix\u202Etests" })).toBe("fix\\u202Etests");
  });
});

describe("comments", () => {
  it("adds, up to the contract's cap", () => {
    expect(addComment(EMPTY, comment("1")).comments).toHaveLength(1);
    const full: ReviewDoc = { seen: [], comments: Array.from({ length: 500 }, (_, i) => comment(`c${i}`)) };
    expect(addComment(full, comment("x"))).toBe(full);
  });

  it("edits the body and clears sentAt, so the comment goes in the next batch", () => {
    const doc: ReviewDoc = { seen: [], comments: [comment("1", { sentAt: 5, body: "old" })] };
    expect(editComment(doc, "1", "new").comments[0]).toMatchObject({ body: "new", sentAt: null });
    expect(editComment(doc, "nope", "new")).toBe(doc);
  });

  it("strips NUL from a body, which the contract refuses", () => {
    const doc: ReviewDoc = { seen: [], comments: [comment("1")] };
    expect(editComment(doc, "1", "a\u0000b").comments[0]?.body).toBe("ab");
  });

  it("resolves and deletes by id", () => {
    const doc: ReviewDoc = { seen: [], comments: [comment("1"), comment("2")] };
    expect(resolveComment(doc, "1", 77).comments.map((c) => c.resolvedAt)).toEqual([77, null]);
    expect(deleteComment(doc, "1").comments.map((c) => c.id)).toEqual(["2"]);
  });

  it("finds the comments to send and marks them sent", () => {
    const doc: ReviewDoc = {
      seen: [],
      comments: [comment("1"), comment("2", { resolvedAt: 1 }), comment("3", { sentAt: 1 }), comment("4")],
    };
    expect(readyToSend(doc).map((c) => c.id)).toEqual(["1", "4"]);
    const sent = markSent(doc, ["1", "4"], 99);
    expect(sent.comments.map((c) => c.sentAt)).toEqual([99, null, 1, 99]);
    expect(readyToSend(sent)).toEqual([]);
  });
});

describe("excerpt", () => {
  it("takes the commented line of the right side, hidden characters written out, clipped to 500", () => {
    const text = "one\r\ntwo\u202Ex\nthree";
    expect(excerptOf(text, 1)).toBe("one");
    expect(excerptOf(text, 2)).toBe("two\\u202Ex");
    expect(excerptOf(text, 9)).toBe("");
    expect(excerptOf("y".repeat(600), 1)).toHaveLength(500);
  });
});
