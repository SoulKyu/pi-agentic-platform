import { describe, expect, it } from "vitest";
import { classifyTool, CODEMODE_SOURCE, MCP_SOURCE, TOOL_SEARCH_SOURCE } from "./tool-kind.ts";

const unknown = { category: "unknown", urlBearing: true, mcp: false, builtin: false } as const;

describe("classifyTool (M5R116)", () => {
  it("keeps M2's categories for Pi's own built-ins", () => {
    expect(classifyTool("bash", { path: "builtin:bash" })).toEqual({
      category: "exec",
      external: false,
      urlBearing: true,
      mcp: false,
      builtin: true,
    });
    expect(classifyTool("read", { path: "builtin:read" })).toEqual({
      category: "read",
      external: false,
      urlBearing: false,
      mcp: false,
      builtin: true,
    });
    expect(classifyTool("write", { path: "builtin:write" }).category).toBe("edit");
    expect(classifyTool("powershell", { path: "builtin:powershell" })).toMatchObject({
      category: "exec",
      urlBearing: true,
    });
    for (const name of ["web_fetch", "web_search", "fetch"])
      expect(classifyTool(name, { path: `builtin:${name}` })).toEqual({
        category: "network",
        external: true,
        urlBearing: true,
        mcp: false,
        builtin: true,
      });
  });

  it("does not trust a built-in name registered by another source", () => {
    expect(classifyTool("read", { path: "/x/ext.js" })).toEqual({ ...unknown, external: true });
    expect(classifyTool("read", { path: "builtin:bash" })).toEqual({ ...unknown, external: true });
  });

  it("treats an extension tool as external unless it declares openWorldHint false", () => {
    expect(classifyTool("web_page", { path: "/x/ext.js" })).toEqual({ ...unknown, external: true });
    expect(classifyTool("web_page", { path: "/x/ext.js", openWorldHint: false })).toEqual({
      ...unknown,
      external: false,
    });
    expect(classifyTool("web_page", { path: "/x/ext.js", openWorldHint: true })).toEqual({
      ...unknown,
      external: true,
    });
    expect(classifyTool("web_page", { path: "/x/ext.js", readOnlyHint: true })).toEqual({
      ...unknown,
      external: true,
    });
  });

  it("takes a name with no registration as the widest case", () => {
    expect(classifyTool("mystery", undefined)).toEqual({ ...unknown, external: true });
  });

  it("matches names exactly", () => {
    expect(classifyTool("READ", { path: "builtin:READ" })).toEqual({ ...unknown, external: true });
    expect(classifyTool("", { path: "builtin:" })).toEqual({ ...unknown, external: true });
    expect(classifyTool("read ", { path: "builtin:read " })).toEqual({ ...unknown, external: true });
  });

  it("does not mistake an Object.prototype key for a built-in", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect(classifyTool(name, { path: `builtin:${name}` })).toEqual({ ...unknown, external: true });
  });
});

describe("MCP, codemode and tool_search are classified by source (M5R24)", () => {
  const mcp = { category: "read", external: true, urlBearing: true, mcp: true, builtin: false } as const;
  const none = { category: "unknown", external: true, urlBearing: true, mcp: false, builtin: false } as const;

  it.each([
    ["a read-only hint", { readOnlyHint: true }, mcp],
    [
      "a read-only hint and openWorldHint false (still external)",
      { readOnlyHint: true, openWorldHint: false },
      mcp,
    ],
    ["a read-only hint and openWorldHint true", { readOnlyHint: true, openWorldHint: true }, mcp],
    ["no hint", {}, { ...mcp, category: "external-write" }],
    ["readOnlyHint false", { readOnlyHint: false }, { ...mcp, category: "external-write" }],
    [
      "only openWorldHint false (still external)",
      { openWorldHint: false },
      { ...mcp, category: "external-write" },
    ],
  ])("an MCP tool with %s", (_label, hints, expected) => {
    expect(classifyTool("mcp__fix__lookup", { path: MCP_SOURCE, ...hints })).toEqual(expected);
  });

  it.each(["read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"])(
    "takes %s as an external read",
    (name) => {
      expect(classifyTool(name, { path: MCP_SOURCE })).toEqual(mcp);
      expect(classifyTool(name, { path: "/ext/spoof.js" })).toEqual(none);
    },
  );

  it("takes codemode and tool_search as reads that are not external", () => {
    expect(classifyTool("codemode", { path: CODEMODE_SOURCE })).toEqual({
      category: "read",
      external: false,
      urlBearing: false,
      mcp: false,
      builtin: false,
    });
    expect(classifyTool("tool_search", { path: TOOL_SEARCH_SOURCE })).toEqual({
      category: "read",
      external: false,
      urlBearing: false,
      mcp: false,
      builtin: false,
    });
  });

  it("does not let an extension borrow an MCP name, a read-only hint included (spoofed names)", () => {
    expect(classifyTool("mcp__fix__lookup", { path: "/ext/spoof.js", readOnlyHint: true })).toEqual(none);
    expect(classifyTool("read_mcp_resource", { path: "/ext/spoof.js" })).toEqual(none);
    expect(classifyTool("mcp__fix__lookup", { path: "builtin:codemode", readOnlyHint: true })).toEqual(none);
    expect(classifyTool("mcp__fix__lookup", undefined)).toEqual(none);
  });

  it("does not let another source claim codemode or tool_search, nor MCP's source claim them", () => {
    for (const name of ["codemode", "tool_search"]) {
      expect(classifyTool(name, { path: "/ext/y.js" })).toEqual(none);
      expect(classifyTool(name, { path: MCP_SOURCE })).toEqual(none);
    }
    expect(classifyTool("codemode", { path: TOOL_SEARCH_SOURCE })).toEqual(none);
  });

  it("matches the MCP prefix exactly and needs a server and a tool name", () => {
    for (const name of ["mcp__", "mcp__fix", "MCP__fix__lookup", " mcp__fix__lookup", "xmcp__fix__lookup"])
      expect(classifyTool(name, { path: MCP_SOURCE, readOnlyHint: true })).toEqual(none);
  });

  it("reads a hint only when it is the boolean (hint shapes)", () => {
    const hostile = { readOnlyHint: "true", openWorldHint: 0 } as unknown as { readOnlyHint: boolean };
    expect(classifyTool("mcp__fix__lookup", { path: MCP_SOURCE, ...hostile })).toEqual({
      ...mcp,
      category: "external-write",
    });
  });
});
