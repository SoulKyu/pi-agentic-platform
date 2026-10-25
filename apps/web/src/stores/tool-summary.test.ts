import { describe, expect, it } from "vitest";
import { editCounts, parseEdits, summarize } from "./tool-summary.ts";

describe("summarize", () => {
  it('an edit reads "README.md · +4 −0"', () => {
    const args = { path: "README.md", edits: [{ oldText: "a", newText: "a\nb\nc\nd\ne" }] };
    expect(summarize("edit", args)).toEqual({ summary: "README.md · +4 −0", argsTruncated: false });
  });

  it("counts after trimming the common leading and trailing lines, over every edit", () => {
    const args = {
      path: "a.ts",
      edits: [
        { oldText: "x\nold\nz", newText: "x\nnew1\nnew2\nz" },
        { oldText: "gone", newText: "" },
      ],
    };
    expect(summarize("edit", args).summary).toBe("a.ts · +2 −2");
  });

  it("reads the single oldText and newText form", () => {
    expect(summarize("edit", { path: "b.md", oldText: "one", newText: "two" }).summary).toBe("b.md · +1 −1");
  });

  it("read and write read their path", () => {
    expect(summarize("read", { path: "src/a.ts", offset: 3 })).toEqual({
      summary: "src/a.ts",
      argsTruncated: false,
    });
    expect(summarize("write", { path: "src/b.ts", content: "x".repeat(500) }).summary).toBe("src/b.ts");
  });

  it("cuts a long path at 200 characters, keeping the edit counts", () => {
    const path = `${"d/".repeat(250)}f.ts`;
    const edit = summarize("edit", { path, oldText: "a", newText: "b" });
    expect(edit.summary.endsWith(" · +1 −1")).toBe(true);
    expect(edit.summary.length).toBeLessThanOrEqual(201 + " · +1 −1".length);
    expect(edit.summary).toContain("… ·");
    const read = summarize("read", { path });
    expect(read.summary).toHaveLength(201);
    expect(read.summary.endsWith("…")).toBe(true);
    expect(read.argsTruncated).toBe(true);
  });

  it("an unknown tool keeps the JSON summary cut at 200", () => {
    expect(summarize("grep", { pattern: "x" })).toEqual({
      summary: '{"pattern":"x"}',
      argsTruncated: false,
    });
    const long = summarize("grep", { pattern: "x".repeat(300) });
    expect(long.summary).toHaveLength(201);
    expect(long.summary.endsWith("…")).toBe(true);
    expect(long.argsTruncated).toBe(true);
    expect(summarize("bash", { command: "ls -la" }).summary).toBe("ls -la");
  });

  it("an edit whose args do not parse keeps the JSON summary", () => {
    expect(summarize("edit", { edits: "nope" }).summary).toBe('{"edits":"nope"}');
    expect(summarize("edit", null).summary).toBe("{}");
  });
});

describe("parseEdits and editCounts", () => {
  it("returns null for text that is not an edit", () => {
    expect(parseEdits("not json")).toBeNull();
    expect(parseEdits('{"path":"a"}')).toBeNull();
    expect(parseEdits('{"path":"a","edits":[{"oldText":1,"newText":"b"}]}')).toBeNull();
  });

  it("parses both shapes", () => {
    expect(parseEdits('{"path":"a","oldText":"x","newText":"y"}')).toEqual({
      path: "a",
      edits: [{ oldText: "x", newText: "y" }],
    });
  });

  it("counts an unchanged edit as nothing", () => {
    expect(editCounts([{ oldText: "same", newText: "same" }])).toEqual({ added: 0, removed: 0 });
  });
});
