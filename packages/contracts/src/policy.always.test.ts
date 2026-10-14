import { describe, expect, it } from "vitest";
import {
  AlwaysScope,
  AlwaysScopes,
  CommandWord,
  DaemonToWorker,
  Dialog,
  DialogResponse,
  parseWorkerRecord,
  PolicyRules,
  PrefixRule,
  ToolRule,
} from "./index.ts";

const base = { profile: "interactive", approvalMode: "auto-accept-edits" };
const KEY = "a".repeat(64);

describe("pattern always-rules (Task 2a)", () => {
  it.each(["pnpm", "test:unit", "@scope/pkg", "--run", "a=b", "x.y_z"])("accepts the word %s", (word) => {
    expect(CommandWord.safeParse(word).success).toBe(true);
  });

  it.each([
    "",
    "a b",
    "a;b",
    "$(x)",
    "`x`",
    "a*",
    "{a,b}",
    "a'b",
    'a"b',
    "a|b",
    "a>b",
    "a\nb",
    "é",
    "x".repeat(129),
  ])("refuses the word %j", (word) => {
    expect(CommandWord.safeParse(word).success).toBe(false);
  });

  it("bounds a prefix rule to one to four words and no extra key", () => {
    expect(PrefixRule.safeParse({ prefix: ["pnpm", "test"] }).success).toBe(true);
    expect(PrefixRule.safeParse({ prefix: [] }).success).toBe(false);
    expect(PrefixRule.safeParse({ prefix: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    expect(PrefixRule.safeParse({ prefix: ["a"], extra: 1 }).success).toBe(false);
  });

  it("names a tool rule's source, builtin or mcp only", () => {
    expect(ToolRule.safeParse({ tool: "mcp__a__b", source: "mcp" }).success).toBe(true);
    expect(ToolRule.safeParse({ tool: "write", source: "builtin" }).success).toBe(true);
    expect(ToolRule.safeParse({ tool: "x", source: "extension" }).success).toBe(false);
    expect(ToolRule.safeParse({ tool: "", source: "mcp" }).success).toBe(false);
  });

  it("defaults the pattern rules to none and bounds them at 1000", () => {
    const rules = PolicyRules.parse(base);
    expect(rules.alwaysPrefixes).toEqual([]);
    expect(rules.alwaysTools).toEqual([]);
    const prefixes = Array.from({ length: 1001 }, () => ({ prefix: ["pnpm", "test"] }));
    expect(PolicyRules.safeParse({ ...base, alwaysPrefixes: prefixes }).success).toBe(false);
    const tools = Array.from({ length: 1001 }, () => ({ tool: "w", source: "mcp" }));
    expect(PolicyRules.safeParse({ ...base, alwaysTools: tools }).success).toBe(false);
  });

  it("knows three scopes and the two offers", () => {
    expect(AlwaysScope.options).toEqual(["exact", "prefix", "tool"]);
    expect(AlwaysScopes.safeParse({ prefix: ["pnpm", "test"], tool: true }).success).toBe(true);
    expect(AlwaysScopes.safeParse({ tool: false }).success).toBe(false);
    expect(AlwaysScopes.safeParse({ other: 1 }).success).toBe(false);
  });

  it("carries the offer on the worker's question and the scope on the daemon's answer", () => {
    const request = {
      type: "approval_request",
      id: "a1",
      category: "exec",
      title: "Run a command?",
      message: "1 line\nbash: pnpm test",
      answers: ["deny", "always", "once"],
      tool: "bash",
      key: KEY,
      alwaysScopes: { prefix: ["pnpm", "test"] },
    };
    expect(parseWorkerRecord(request)).toMatchObject({ alwaysScopes: { prefix: ["pnpm", "test"] } });
    expect(parseWorkerRecord({ ...request, alwaysScopes: { prefix: ["a b"] } })).toMatchObject({
      type: "approval_request_invalid",
    });
    const response = { type: "approval_response", id: "a1", answer: "always" };
    expect(DaemonToWorker.parse({ ...response, scope: "prefix" })).toMatchObject({ scope: "prefix" });
    expect(DaemonToWorker.safeParse({ ...response, scope: "everything" }).success).toBe(false);
  });

  it("carries the offer on the dialog and the scope on its response", () => {
    const dialog = {
      id: "a1",
      method: "approval",
      title: "t",
      message: "m",
      category: "exec",
      answers: ["deny", "always", "once"],
      alwaysScopes: { tool: true },
    };
    expect(Dialog.parse(dialog)).toMatchObject({ alwaysScopes: { tool: true } });
    expect(Dialog.safeParse({ ...dialog, alwaysScopes: { tool: false } }).success).toBe(false);
    expect(DialogResponse.parse({ answer: "always", scope: "prefix" })).toEqual({
      answer: "always",
      scope: "prefix",
    });
    expect(DialogResponse.safeParse({ answer: "always", scope: "all" }).success).toBe(false);
  });
});
