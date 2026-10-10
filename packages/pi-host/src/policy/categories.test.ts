import type { ToolCategory } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { toolCategory } from "./categories.ts";

describe("toolCategory", () => {
  it.each([
    ["read", "read"],
    ["edit", "edit"],
    ["bash", "exec"],
    ["web_fetch", "network"],
    ["some_extension_tool", "unknown"],
    ["mcp__github__create_issue", "unknown"],
    ["READ", "unknown"],
    ["", "unknown"],
  ] satisfies Array<[string, ToolCategory]>)("%j is %s", (tool, expected) => {
    expect(toolCategory(tool)).toBe(expected);
  });
});
