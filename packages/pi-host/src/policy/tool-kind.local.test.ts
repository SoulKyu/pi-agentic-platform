import { describe, expect, it } from "vitest";
import type { LocalToolRule } from "@pap/contracts";
import {
  classifyTool,
  CODEMODE_SOURCE,
  isMarkableSource,
  MCP_SOURCE,
  PLATFORM_SOURCE,
  SANDBOX_SOURCE,
  TOOL_SEARCH_SOURCE,
} from "./tool-kind.ts";

const TODO = "/x/ext/todo.ts";
const todo: LocalToolRule = { tool: "todo", source: TODO };
const local = {
  category: "read",
  external: false,
  urlBearing: false,
  mcp: false,
  builtin: false,
} as const;
const unknown = {
  category: "unknown",
  external: true,
  urlBearing: true,
  mcp: false,
  builtin: false,
} as const;

// Mutants (each run for real, A2 report):
//  M1 match on the name only (source ignored)       -> "stays unknown from another source"
//  M2 local rule applied before built-in/MCP/platform/sandbox/codemode checks -> "keeps the classification of ..."
//  M3 `external` left true for a local tool          -> "makes the extension tool a local read"
//  M4 drop the reserved-source guard (`isMarkableSource`) -> "keeps tools of reserved sources unknown and external"
describe("classifyTool with the owner's local tools (decision 117, A2)", () => {
  it("makes the extension tool a local read, not external", () => {
    expect(classifyTool("todo", { path: TODO }, [todo])).toEqual(local);
    expect(classifyTool("todo", { path: TODO, openWorldHint: true }, [todo])).toEqual(local);
  });

  it("stays unknown and external from another source or under another name", () => {
    expect(classifyTool("todo", { path: "/y/ext/todo.ts" }, [todo])).toEqual(unknown);
    expect(classifyTool("todo", { path: `${TODO}x` }, [todo])).toEqual(unknown);
    expect(classifyTool("todo", undefined, [todo])).toEqual(unknown);
    expect(classifyTool("todo2", { path: TODO }, [todo])).toEqual(unknown);
    expect(classifyTool("Todo", { path: TODO }, [todo])).toEqual(unknown);
  });

  it("changes nothing with an empty or absent list", () => {
    expect(classifyTool("todo", { path: TODO }, [])).toEqual(unknown);
    expect(classifyTool("todo", { path: TODO })).toEqual(unknown);
  });

  it("keeps the classification of built-ins, MCP, platform, sandbox, codemode and tool_search tools", () => {
    const named = (tool: string, source: string): LocalToolRule[] => [{ tool, source }];
    const cases: Array<[string, string]> = [
      ["bash", "builtin:bash"],
      ["web_fetch", "builtin:web_fetch"],
      ["mcp__fix__lookup", MCP_SOURCE],
      ["read_mcp_resource", MCP_SOURCE],
      ["codemode", CODEMODE_SOURCE],
      ["tool_search", "builtin:tool-search"],
      ["agent_notify", PLATFORM_SOURCE],
      ["bash", SANDBOX_SOURCE],
    ];
    for (const [name, path] of cases) {
      const facts = { path, sandboxNetwork: true };
      expect(classifyTool(name, facts, named(name, path))).toEqual(classifyTool(name, facts, []));
    }
    expect(classifyTool("bash", { path: "builtin:bash" }, named("bash", "builtin:bash")).category).toBe(
      "exec",
    );
    expect(
      classifyTool("mcp__fix__lookup", { path: MCP_SOURCE }, named("mcp__fix__lookup", MCP_SOURCE)),
    ).toMatchObject({
      mcp: true,
      external: true,
    });
  });

  it("keeps tools of reserved sources unknown and external, even when a rule names them", () => {
    const cases: Array<[string, string, boolean?]> = [
      ["mcp", MCP_SOURCE],
      ["foo", MCP_SOURCE],
      ["x", CODEMODE_SOURCE],
      ["x", TOOL_SEARCH_SOURCE],
      ["not_an_op", PLATFORM_SOURCE],
      ["bash", SANDBOX_SOURCE],
      ["bash", "builtin:other"],
      ["other", "builtin:other"],
    ];
    for (const [name, path] of cases)
      expect(classifyTool(name, { path }, [{ tool: name, source: path }])).toEqual(unknown);
    expect(isMarkableSource("builtin:x")).toBe(false);
    expect(isMarkableSource("<inline:3>")).toBe(false);
    expect(isMarkableSource(TODO)).toBe(true);
  });

  it("does not let a local rule turn an extension that took a built-in's name into the built-in", () => {
    const rule = { tool: "bash", source: "/x/ext/bash.ts" };
    expect(classifyTool("bash", { path: "/x/ext/bash.ts" }, [rule])).toEqual(local);
    expect(classifyTool("bash", { path: "builtin:bash" }, [rule]).builtin).toBe(true);
  });
});
