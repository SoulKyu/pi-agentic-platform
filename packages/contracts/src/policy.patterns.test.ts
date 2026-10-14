import { describe, expect, it } from "vitest";
import { AlwaysScopes } from "./policy.ts";
import { methods } from "./methods.ts";
import { Dialog } from "./streams.ts";

const listed = methods["policy.listRules"].result;
const rule = { id: "r1", scope: "/w", tool: "bash", label: "l", createdAt: 1 };

describe("pattern rules in the contracts (M7 Task 2b)", () => {
  it("lets a tool offer name its registered source, builtin or mcp, and nothing else", () => {
    expect(AlwaysScopes.safeParse({ tool: true, toolSource: "mcp" }).success).toBe(true);
    expect(AlwaysScopes.safeParse({ tool: true, toolSource: "builtin" }).success).toBe(true);
    expect(AlwaysScopes.safeParse({ tool: true, toolSource: "extension" }).success).toBe(false);
  });

  it("names the tool a question is about on the dialog, bounded", () => {
    const dialog = { id: "a1", method: "approval", title: "t", category: "exec", answers: ["deny", "once"] };
    expect(Dialog.parse({ ...dialog, tool: "mcp__fix__write" })).toMatchObject({ tool: "mcp__fix__write" });
    expect(Dialog.safeParse({ ...dialog, tool: "t".repeat(257) }).success).toBe(false);
    expect(Dialog.safeParse({ ...dialog, tool: "" }).success).toBe(false);
  });

  it("gives a listed rule its kind, and a prefix rule its words", () => {
    expect(listed.safeParse({ rules: [{ ...rule, kind: "exact" }], truncated: false }).success).toBe(true);
    expect(listed.safeParse({ rules: [rule], truncated: false }).success).toBe(false);
    expect(listed.safeParse({ rules: [{ ...rule, kind: "glob" }], truncated: false }).success).toBe(false);
    const prefix = { ...rule, kind: "prefix", pattern: ["pnpm", "test"] };
    expect(listed.parse({ rules: [prefix], truncated: false }).rules[0]).toEqual(prefix);
    for (const pattern of [["a b"], [], ["a", "b", "c", "d", "e"], "pnpm test"]) {
      expect(listed.safeParse({ rules: [{ ...prefix, pattern }], truncated: false }).success).toBe(false);
    }
  });
});
