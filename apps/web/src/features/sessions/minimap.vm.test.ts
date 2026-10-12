import { describe, expect, it } from "vitest";
import { minimapTurns, rowId } from "./minimap.vm.ts";

const user = (key: string, text: string) =>
  ({ kind: "message", key, author: "you", text, thinking: "", entryId: key }) as const;

describe("minimapTurns", () => {
  it("numbers turns from the branch's start and counts their tools", () => {
    const items = [
      {
        kind: "message",
        key: "u5",
        author: "you",
        text: "Fix the login\nplease",
        thinking: "",
        entryId: "u5",
      },
      { kind: "message", key: "a5", author: "agent", text: "Looking", thinking: "", entryId: "a5" },
      { kind: "tool", key: "c1" },
      { kind: "tool", key: "c2" },
      {
        kind: "summary",
        key: "s1",
        variant: "compaction",
        text: "earlier work",
        tokensBefore: 10,
        entryId: "s1",
      },
    ] as const;
    expect(minimapTurns(items as never, 4)).toEqual([
      { number: 5, key: "u5", preview: "Fix the login please", tools: 2 },
      { number: 6, key: "s1", preview: "earlier work", tools: 0 },
    ]);
  });

  it("skips rows before the first turn and the failure and partial rows", () => {
    const items = [
      { kind: "message", key: "a1", author: "agent", text: "tail of a turn", thinking: "", entryId: "a1" },
      { kind: "tool", key: "c0" },
      user("u2", "next"),
      { kind: "failure", key: "f", text: "boom" },
      { kind: "partial", key: "partial", text: "typing", thinking: "" },
    ];
    expect(minimapTurns(items as never, 0)).toEqual([{ number: 1, key: "u2", preview: "next", tools: 0 }]);
  });

  it("shows text only: control and bidi characters go, white space collapses to one line", () => {
    const items = [user("u1", "\u202Eevil\u0007 \t a\n\n b\u200B  c")];
    expect(minimapTurns(items as never, 0)[0]?.preview).toBe("evil a b c");
  });

  it("cuts the preview at 200 characters without splitting a surrogate pair", () => {
    const flat = minimapTurns([user("u1", "x".repeat(300))] as never, 0)[0]?.preview;
    expect(flat).toBe("x".repeat(200));
    const pair = minimapTurns([user("u1", `${"x".repeat(199)}😀tail`)] as never, 0)[0]?.preview;
    expect(pair).toBe("x".repeat(199));
    const fits = minimapTurns([user("u1", `${"x".repeat(198)}😀tail`)] as never, 0)[0]?.preview;
    expect(fits).toBe(`${"x".repeat(198)}😀`);
  });

  it("builds a row id per screen scope", () => {
    expect(rowId(":r1:", "call:1#0")).toBe("row-:r1:-call:1#0");
    expect(rowId(":r1:", "a")).not.toBe(rowId(":r2:", "a"));
  });
});
