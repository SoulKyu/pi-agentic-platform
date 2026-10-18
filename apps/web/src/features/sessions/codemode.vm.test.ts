import { describe, expect, it } from "vitest";
import { codemodeView, previewLine, sectionsOf, withoutHeader } from "./codemode.vm.ts";
import type { ToolItem } from "./transcript.vm.ts";

const must = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
};

const HEADER = "Script completed\nWall time 0.1 seconds\nOutput:\n";
const item = (patch: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  key: "a:cm1#0",
  toolCallId: "cm1",
  name: "codemode",
  summary: '{"code":"…"}',
  status: "done",
  preview: `${HEADER}==> text 1/2 <==\nfirst\n==> text 2/2 <==\nsecond`,
  truncatedChars: null,
  argsTruncated: false,
  resultEntryId: null,
  omittedBytes: null,
  code: "// read both\n\nconst a = await tools.read({ path: 'a' });\ntext(a);",
  nested: [
    { name: "read", args: '{"path":"a"}', status: "ok", durationMs: 4, error: null },
    { name: "read", args: '{"path":"b"}', status: "error", durationMs: 7, error: "ENOENT" },
  ],
  ...patch,
});

describe("previewLine", () => {
  it("is the first line that says something: blank and comment-only lines are skipped", () => {
    expect(previewLine("\n  // note\n/* x */\n  const a = 1;\nb")).toBe("const a = 1;");
  });
  it("is empty for a script with nothing but comments", () => {
    expect(previewLine("// only\n")).toBe("");
  });
});

describe("withoutHeader", () => {
  it("removes the Script completed / Wall time / Output lines and returns the wall time", () => {
    const out = withoutHeader([{ kind: "plain", text: `${HEADER}hello` }]);
    expect(out).toEqual({ parts: [{ kind: "plain", text: "hello" }], wall: "0.1 s", failedHeader: false });
  });
  it("also strips it when a fence wraps the whole result", () => {
    const out = withoutHeader([{ kind: "fenced", source: "mcp", text: `${HEADER}x` }]);
    expect(out.parts).toEqual([{ kind: "fenced", source: "mcp", text: "x" }]);
  });
  it("knows a failed script and keeps its error text", () => {
    const out = withoutHeader([
      { kind: "plain", text: "Script failed\nWall time 2 seconds\nOutput:\npartial\nScript error:\nboom" },
    ]);
    expect(out.failedHeader).toBe(true);
    expect(out.wall).toBe("2 s");
    expect(out.parts[0]).toEqual({ kind: "plain", text: "partial\nScript error:\nboom" });
  });
  it("keeps a text without the header whole (rejected input)", () => {
    const parts = [{ kind: "plain", text: "Invalid options" }] as const;
    expect(withoutHeader(parts)).toEqual({ parts, wall: null, failedHeader: false });
  });
});

describe("sectionsOf", () => {
  it("splits on the text i/n separators and drops them", () => {
    expect(sectionsOf("==> text 1/2 <==\nfirst\n==> text 2/2 <==\nsecond\n")).toEqual(["first", "second"]);
  });
  it("keeps a text with no separator as one block", () => {
    expect(sectionsOf("just\ntext")).toEqual(["just\ntext"]);
    expect(sectionsOf("   ")).toEqual([]);
  });
});

describe("codemodeView", () => {
  it("builds the header from the script, the call count and the wall time", () => {
    const view = must(codemodeView(item(), null));
    expect(view.preview).toBe("const a = await tools.read({ path: 'a' });");
    expect(view.calls).toHaveLength(2);
    expect(view.wall).toBe("0.1 s");
    expect(view.code).toContain("// read both");
  });
  it("applies only to the codemode tool with a script string", () => {
    expect(codemodeView(item({ name: "bash" }), null)).toBeNull();
    expect(codemodeView(item({ code: undefined }), null)).toBeNull();
  });
  it("takes the whole script from the loaded arguments when they parse", () => {
    const view = must(codemodeView(item({ argsTruncated: true }), JSON.stringify({ code: "text('whole')" })));
    expect(view.code).toBe("text('whole')");
    expect(must(codemodeView(item({ argsTruncated: true }), '{"code":"cut')).code).toContain("// read both");
  });
  it("has no calls or wall time when the result carries none", () => {
    const view = must(codemodeView(item({ nested: undefined, preview: "" }), null));
    expect(view.calls).toBeUndefined();
    expect(view.wall).toBeNull();
  });
});
