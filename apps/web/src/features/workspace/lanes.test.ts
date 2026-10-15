import { describe, expect, it } from "vitest";
import { itemFromPath, pathOfItem } from "./item-path.ts";
import { itemKey } from "./model.ts";
import { parseWorkspace, serializeWorkspace } from "./persist.ts";

const FAN = "0123456789abcdef";

describe("lane and compare items", () => {
  it("round-trip through the path and have their own keys", () => {
    for (const [path, item] of [
      ["/lane/fix-a-1a2b", { kind: "lane", id: "fix-a-1a2b" }],
      [`/compare/${FAN}`, { kind: "compare", id: FAN }],
    ] as const) {
      expect(itemFromPath(path, false)).toEqual(item);
      expect(pathOfItem(item)).toBe(path);
    }
    expect(itemKey({ kind: "lane", id: "fix-a-1a2b" })).toBe("lane:fix-a-1a2b");
    expect(itemKey({ kind: "compare", id: FAN })).toBe(`compare:${FAN}`);
  });

  it.each([
    "/lane/",
    "/lane/BAD",
    "/lane/a/b",
    "/lane/fix-a",
    "/compare/xyz",
    `/compare/${FAN}0`,
    "/lane/%2e%2e",
  ])("%s is not found", (path) => expect(itemFromPath(path, false)).toBeNull());

  it("a bad id gives the home path, never a throw", () => {
    expect(pathOfItem({ kind: "lane", id: "../x" })).toBe("/");
    expect(pathOfItem({ kind: "compare", id: "x" })).toBe("/");
  });

  it("survive a reload of the stored workspace, and a bad stored id is dropped", () => {
    const ws = {
      tabs: [
        { key: "lane:fix-a-1a2b", item: { kind: "lane", id: "fix-a-1a2b" }, split: null },
        { key: `compare:${FAN}`, item: { kind: "compare", id: FAN }, split: null },
      ],
      active: "lane:fix-a-1a2b",
    } as const;
    expect(parseWorkspace(serializeWorkspace(ws), false)).toEqual(ws);
    const bad = JSON.stringify({
      v: 1,
      tabs: [{ key: "lane:Bad", item: { kind: "lane", id: "Bad" }, split: null }],
      active: null,
    });
    expect(parseWorkspace(bad, false).tabs).toEqual([]);
  });
});
