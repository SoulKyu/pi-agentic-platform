import { describe, expect, it } from "vitest";
import { classifyTool, VM_FILES_SOURCE } from "./tool-kind.ts";

const FILES = { path: VM_FILES_SOURCE, vm: true } as const;

describe("classifyTool for pap's VM file tools (R26)", () => {
  it("pins the source", () => {
    expect(VM_FILES_SOURCE).toBe("<inline:pap-vm-files>");
  });

  it("classifies read, write, edit and ls from the source in a VM worker exactly like Pi's built-in", () => {
    for (const name of ["read", "write", "edit", "ls"])
      expect(classifyTool(name, FILES), name).toEqual(classifyTool(name, { path: `builtin:${name}` }));
    expect(classifyTool("read", FILES)).toMatchObject({ category: "read", builtin: true });
    expect(classifyTool("write", FILES)).toMatchObject({ category: "edit", builtin: true });
  });

  it("is unknown (fail closed) from a worker whose policy config has no `vm`", () => {
    for (const name of ["read", "write", "edit", "ls"])
      expect(classifyTool(name, { path: VM_FILES_SOURCE }), name).toMatchObject({
        category: "unknown",
        external: true,
        builtin: false,
      });
  });

  it("only the four names: `grep`, `find`, `bash` or anything else from the source is unknown", () => {
    for (const name of ["grep", "find", "bash", "web_fetch", "mystery"])
      expect(classifyTool(name, FILES), name).toMatchObject({ category: "unknown", builtin: false });
  });

  it("a facts object claiming `vm` from another source is not trusted", () => {
    expect(classifyTool("read", { path: "/x/ext.js", vm: true })).toMatchObject({
      category: "unknown",
      builtin: false,
    });
  });
});
