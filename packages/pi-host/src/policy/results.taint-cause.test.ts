import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { type LocalToolRule, NO_TAINT } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRedactor } from "./redact.ts";
import { onToolResult, type ResultDeps } from "./results.ts";
import { createExternalRoots, createTaint } from "./taint.ts";
import { classifyTool, MCP_SOURCE, type ToolFacts } from "./tool-kind.ts";

// Decision 117, A3 and APR-8: the worker names what tainted the session. Mutant "sticky bit ignored" (M9): taint.test.ts and "a not markable cause first, then 9 markable tools".
// Decision 117, A3: the worker names what tainted the session. Mutants (each run for real, see the A3 report):
//  M1 `markable` ignores `isMarkableSource` (a built-in or MCP tool becomes markable): "a web_search result" and "an MCP tool".
//  M2 a local tool records a cause or taints: "a local tool".
//  M3 clear keeps the causes: taint.test.ts "forgets the causes on a clear".
//  M4 `isMarkableSource` dropped: "an unknown name from a reserved source".
//  M5 `kind.external` dropped from `markable`: "a closed world ... only its parent". (`kind.category === "unknown"` is implied by
//     the rest for every source a rule can name, so dropping it alone changes nothing observable.)
//  M6 `causes()` ignores `known` (causes named for a taint the worker did not see rise): taint.test.ts "names no cause ..."
let quiet: { mockRestore(): void } | undefined;
beforeEach(() => {
  quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => quiet?.mockRestore());

const SOURCES: Record<string, string> = {
  web_search: "builtin:web_search",
  todo: "/x/ext/todo.ts",
  mcp__srv__tool: MCP_SOURCE,
  closed_world: "/x/ext/closed.ts",
  platform_unknown: "<inline:pap-platform>",
  weird: "/x/ext/\u202eweird.ts",
};
const facts = (name: string): ToolFacts | undefined => {
  const path = SOURCES[name] ?? (/^ext\d$/.test(name) ? `/x/ext/${name}.ts` : undefined);
  return path === undefined
    ? undefined
    : { path, ...(name === "closed_world" ? { openWorldHint: false } : {}) };
};

function setup(localTools: LocalToolRule[] = [], now = () => 1_000) {
  const taint = createTaint(NO_TAINT, () => {}, now);
  const deps: ResultDeps = {
    secrets: { current: () => createRedactor({ entries: [] }), refresh: () => {} },
    audit: () => {},
    classify: (name) => classifyTool(name, facts(name), localTools),
    facts,
    taint,
    roots: createExternalRoots(),
  };
  return { taint, deps };
}
let id = 0;
const result = (toolName: string, toolCallId = `c${++id}`): ToolResultEvent =>
  ({
    type: "tool_result",
    toolCallId,
    toolName,
    input: {},
    isError: false,
    content: [{ type: "text", text: "text" }],
    details: undefined,
  }) as unknown as ToolResultEvent;

describe("taint causes of a result", () => {
  it("a web_search result records a cause that is not markable", () => {
    const { taint, deps } = setup();
    onToolResult(result("web_search"), deps);
    expect(taint.causes().list).toEqual([
      { tool: "web_search", source: "builtin:web_search", at: 1_000, count: 1, markable: false },
    ]);
  });

  it("an MCP tool records a cause that is not markable", () => {
    const { taint, deps } = setup();
    onToolResult(result("mcp__srv__tool"), deps);
    expect(taint.causes().list).toEqual([
      { tool: "mcp__srv__tool", source: MCP_SOURCE, at: 1_000, count: 1, markable: false },
    ]);
  });

  it("an extension tool of the unknown fallback records a markable cause with its exact source", () => {
    const { taint, deps } = setup();
    onToolResult(result("todo"), deps);
    expect(taint.causes().list).toEqual([
      { tool: "todo", source: "/x/ext/todo.ts", at: 1_000, count: 1, markable: true },
    ]);
  });

  it("a source with an invisible character is cleaned and not markable, so the card stays valid", () => {
    const { taint, deps } = setup();
    onToolResult(result("weird"), deps);
    expect(taint.causes().list).toEqual([
      { tool: "weird", source: "/x/ext/weird.ts", at: 1_000, count: 1, markable: false },
    ]);
  });

  it("an unknown name from a reserved source (platform) is not markable", () => {
    const { taint, deps } = setup();
    onToolResult(result("platform_unknown"), deps);
    expect(taint.causes().list).toMatchObject([{ tool: "platform_unknown", markable: false }]);
  });

  it("a result external only through its parent is not markable, though its source could be", () => {
    const { taint, deps } = setup([{ tool: "todo", source: "/x/ext/todo.ts" }]);
    deps.roots.add("under-external");
    onToolResult(result("todo", "under-external"), deps);
    expect(taint.causes().list).toMatchObject([{ tool: "todo", markable: false }]);
  });

  it("an unknown tool that declares a closed world is not markable when only its parent made it external", () => {
    const { taint, deps } = setup();
    deps.roots.add("under-external");
    onToolResult(result("closed_world", "under-external"), deps);
    expect(taint.causes().list).toMatchObject([{ tool: "closed_world", markable: false }]);
  });

  it("a local tool records no cause and does not taint", () => {
    const { taint, deps } = setup([{ tool: "todo", source: "/x/ext/todo.ts" }]);
    onToolResult(result("todo"), deps);
    expect(taint.current()).toBe(false);
    expect(taint.causes().list).toEqual([]);
  });

  it("gives 20 results of one tool one entry with its count, and it stays markable", () => {
    let clock = 0;
    const { taint, deps } = setup([], () => (clock += 10));
    for (let i = 0; i < 20; i++) onToolResult(result("todo"), deps);
    expect(taint.causes()).toEqual({
      list: [{ tool: "todo", source: "/x/ext/todo.ts", at: 200, count: 20, markable: true }],
      older: 0,
    });
  });

  // APR-8: the dropped web_search must not let the markable ones that followed be lifted from the card.
  it("a not markable cause first, then 9 markable tools: nothing is markable and the older ones are counted", () => {
    const { taint, deps } = setup();
    onToolResult(result("web_search"), deps);
    for (let i = 0; i < 9; i++) onToolResult(result(`ext${i}`), deps);
    const { list, older } = taint.causes();
    expect(list).toHaveLength(8);
    expect(older).toBe(2);
    expect(list.map((cause) => cause.markable)).toEqual(Array(8).fill(false));
  });
});
