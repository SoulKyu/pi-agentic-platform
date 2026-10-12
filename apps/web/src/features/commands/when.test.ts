import { describe, expect, it } from "vitest";
import { evaluateWhen, mentions, parseWhen, type WhenNode } from "./when.ts";

const run = (text: string, context: Record<string, boolean>) =>
  evaluateWhen(parseWhen(text) as WhenNode, context);

describe("when clauses (T3 grammar)", () => {
  it("evaluates !, &&, || and parentheses with ! > && > ||", () => {
    expect(run("a && !b", { a: true, b: false })).toBe(true);
    expect(run("a || b && c", { a: false, b: true, c: false })).toBe(false);
    expect(run("(a || b) && c", { a: true, c: true })).toBe(true);
    expect(run("unknownKey", {})).toBe(false);
    expect(run("true && !false", {})).toBe(true);
  });
  it("binds ! tighter than &&, and && tighter than ||", () => {
    expect(run("a || b && c", { a: true, b: false, c: false })).toBe(true);
    expect(run("(a || b) && c", { a: true, c: false })).toBe(false);
    expect(run("!a && b", { a: false, b: false })).toBe(false);
    expect(run("!(a && b)", { a: false, b: false })).toBe(true);
  });
  it("reports where a clause is broken", () => {
    expect(parseWhen("")).toEqual({ error: "empty", at: 0 });
    expect(parseWhen("a &&")).toEqual({ error: "unexpected", at: 4 });
    expect(parseWhen("(a")).toEqual({ error: "unclosed", at: 2 });
    expect(parseWhen("a & b")).toEqual({ error: "unexpected", at: 2 });
    expect(parseWhen("(".repeat(65) + "a" + ")".repeat(65))).toMatchObject({ error: "too_deep" });
  });
  it("knows which keys a clause reads", () => {
    expect(mentions(parseWhen("!editableFocus && dialogOpen") as WhenNode, "editableFocus")).toBe(true);
    expect(mentions(parseWhen("dialogOpen") as WhenNode, "editableFocus")).toBe(false);
  });
  it("treats prototype names as unknown keys and refuses oversize or non-string text", () => {
    expect(run("constructor || toString || __proto__", {})).toBe(false);
    expect(run("evil", Object.create({ evil: true }) as Record<string, boolean>)).toBe(false);
    expect(parseWhen("a || ".repeat(60) + "a")).toEqual({ error: "unexpected", at: 256 });
    expect(parseWhen(42 as never)).toEqual({ error: "empty", at: 0 });
  });
});
