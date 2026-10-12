import { describe, expect, it } from "vitest";
import { classifyTool } from "./tool-kind.ts";

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
