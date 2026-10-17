import { describe, expect, it } from "vitest";
import { agentCategory, decideIsolated, type IsolatedInput } from "./agent-decide.ts";

const base: IsolatedInput = {
  category: "read",
  external: false,
  sandboxedShell: false,
  sandboxNetwork: false,
  mode: "auto-accept-edits",
  tainted: false,
  insideReach: true,
  hostList: false,
};
const verdict = (over: Partial<IsolatedInput>) => decideIsolated({ ...base, ...over });
const sandboxed = { category: "exec", external: true, sandboxedShell: true } as const;
const urlTool = { category: "network", external: true } as const;

describe("agentCategory (owner m2)", () => {
  it("makes a sandboxed shell without network an edit that is not external", () => {
    expect(agentCategory({ ...base, ...sandboxed, sandboxNetwork: false })).toEqual({
      category: "edit",
      external: false,
    });
  });

  it("keeps a sandboxed shell with network exec and external", () => {
    expect(agentCategory({ ...base, ...sandboxed, sandboxNetwork: true })).toEqual({
      category: "exec",
      external: true,
    });
  });

  it("keeps the category of every other call", () => {
    expect(agentCategory({ ...base, category: "exec", external: false })).toEqual({
      category: "exec",
      external: false,
    });
    expect(agentCategory({ ...base, category: "read", external: true })).toEqual({
      category: "read",
      external: true,
    });
  });
});

describe("decideIsolated (C 5.3, unattended column; owner m17)", () => {
  it("lets a read inside the home or the scratch folder run", () => {
    expect(verdict({}).decision).toBe("allow");
  });

  it("blocks a read outside both", () => {
    expect(verdict({ insideReach: false })).toMatchObject({ decision: "block" });
  });

  it("blocks an MCP read without a host list, allows it with one, asks when tainted", () => {
    const mcp = { category: "read", external: true, insideReach: false } as const;
    expect(verdict(mcp).decision).toBe("block");
    expect(verdict({ ...mcp, hostList: true }).decision).toBe("allow");
    expect(verdict({ ...mcp, hostList: true, tainted: true }).decision).toBe("ask");
  });

  it("lets a read through in read-only mode", () => {
    expect(verdict({ mode: "read-only" }).decision).toBe("allow");
  });

  it("allows an edit in the scratch folder in auto-accept-edits and asks in supervised", () => {
    expect(verdict({ category: "edit" }).decision).toBe("allow");
    expect(verdict({ category: "edit", mode: "supervised" }).decision).toBe("ask");
  });

  it("blocks an edit outside the scratch folder (the home included) and in read-only", () => {
    expect(verdict({ category: "edit", insideReach: false }).decision).toBe("block");
    expect(verdict({ category: "edit", mode: "read-only" }).decision).toBe("block");
  });

  it("blocks Pi's bash and any other shell that is not the sandboxed one", () => {
    expect(verdict({ category: "exec" })).toMatchObject({
      decision: "block",
      why: "unsandboxed shell in an isolated task",
    });
  });

  it("allows the sandboxed shell without network, even tainted, and blocks it in read-only", () => {
    expect(verdict({ ...sandboxed }).decision).toBe("allow");
    expect(verdict({ ...sandboxed, tainted: true }).decision).toBe("allow");
    expect(verdict({ ...sandboxed, mode: "read-only" }).decision).toBe("block");
    expect(verdict({ ...sandboxed, mode: "supervised" }).decision).toBe("ask");
  });

  it("blocks the sandboxed shell when its one writable folder is not named (nothing in reach)", () => {
    expect(verdict({ ...sandboxed, insideReach: false })).toMatchObject({ decision: "block" });
  });

  it("blocks a networked sandboxed shell with a host list when its scratch folder is not named", () => {
    const networked = { ...sandboxed, sandboxNetwork: true, hostList: true };
    expect(verdict({ ...networked, insideReach: false }).decision).toBe("block");
    expect(verdict(networked).decision).toBe("ask");
  });

  it("blocks a sandboxed shell with network without a host list and asks with one", () => {
    expect(verdict({ ...sandboxed, sandboxNetwork: true }).decision).toBe("block");
    expect(verdict({ ...sandboxed, sandboxNetwork: true, hostList: true }).decision).toBe("ask");
  });

  it("blocks a URL tool without a host list, allows a listed one, asks when tainted or supervised", () => {
    expect(verdict(urlTool).decision).toBe("block");
    expect(verdict({ ...urlTool, hostList: true }).decision).toBe("allow");
    expect(verdict({ ...urlTool, hostList: true, tainted: true }).decision).toBe("ask");
    expect(verdict({ ...urlTool, hostList: true, mode: "supervised" }).decision).toBe("ask");
    expect(verdict({ ...urlTool, hostList: true, mode: "read-only" }).decision).toBe("block");
  });

  it("asks for an MCP write and blocks a tool of unknown kind", () => {
    expect(verdict({ category: "external-write", external: true }).decision).toBe("ask");
    expect(verdict({ category: "unknown", external: true }).decision).toBe("block");
  });

  it("only ever offers Deny and Allow once", () => {
    const asks = [
      verdict({ category: "edit", mode: "supervised" }),
      verdict({ category: "external-write", external: true }),
      verdict({ ...sandboxed, sandboxNetwork: true, hostList: true }),
    ];
    for (const each of asks) expect(each).toMatchObject({ decision: "ask", answers: ["deny", "once"] });
  });
});
