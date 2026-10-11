import { describe, expect, it } from "vitest";
import { normalizeSearch, rankItems, type PaletteItem } from "./rank.ts";

const item = (
  id: string,
  group: PaletteItem["group"],
  title: string,
  extra: Partial<PaletteItem> = {},
): PaletteItem => ({
  id,
  group,
  title,
  searchTerms: [title],
  run: () => {},
  ...extra,
});
const items = [
  item("a1", "actions", "Open settings"),
  item("a2", "actions", "Split pane"),
  item("s1", "sessions", "pi-agentic", { searchTerms: ["pi-agentic", "/home/ana/pi-agentic"], recency: 5 }),
  item("s2", "sessions", "settings-app", { recency: 9 }),
  item("g1", "settings", "Appearance", { searchTerms: ["Appearance", "theme density"] }),
];
const ids = (result: ReturnType<typeof rankItems>) => result.groups.flatMap((g) => g.items.map((i) => i.id));

describe("palette ranking (T3 CommandPalette.logic.ts)", () => {
  it("normalizes accents and case", () => {
    expect(normalizeSearch("Réglages Thème")).toBe("reglages theme");
  });
  it("keeps the natural order without a query", () => {
    expect(ids(rankItems(items, ""))).toEqual(["a1", "a2", "s1", "s2", "g1"]);
  });
  it("needs every token, prefers the title and exact or prefix matches", () => {
    expect(ids(rankItems(items, "settings"))).toEqual(["a1", "s2"]);
    expect(ids(rankItems(items, "theme"))).toEqual(["g1"]);
    expect(ids(rankItems(items, "open set"))).toEqual(["a1"]);
  });
  it("keeps actions only after >", () => {
    const result = rankItems(items, "> pane");
    expect([ids(result), result.actionsOnly]).toEqual([["a2"], true]);
  });
  it("renders at most 50 rows per group and counts them all", () => {
    const many = Array.from({ length: 80 }, (_, i) => item(`x${i}`, "sessions", `project ${i}`));
    const result = rankItems(many, "project");
    expect([result.groups[0]?.items.length, result.count]).toEqual([50, 80]);
  });
  it("orders inside a group by score, then recency, then position", () => {
    const pool = [
      item("late", "sessions", "my app", { searchTerms: ["x", "app"] }),
      item("old", "sessions", "app one", { recency: 1 }),
      item("new", "sessions", "app two", { recency: 2 }),
    ];
    expect(ids(rankItems(pool, "app"))).toEqual(["new", "old", "late"]);
  });
  it("puts an exact title match before a prefix, and a prefix before a substring (same group)", () => {
    const pool = [
      item("sub", "sessions", "my bar"),
      item("pre", "sessions", "bar tools"),
      item("exact", "sessions", "bar"),
    ];
    expect(ids(rankItems(pool, "bar"))).toEqual(["exact", "pre", "sub"]);
  });
  it("after > returns actions only, even when sessions and settings match the words", () => {
    expect(ids(rankItems(items, "> settings"))).toEqual(["a1"]);
    expect(ids(rankItems(items, "settings"))).toEqual(["a1", "s2"]);
    const bare = rankItems(items, ">");
    expect([ids(bare), bare.count, bare.actionsOnly]).toEqual([["a1", "a2"], 2, true]);
  });
  it("keeps the given order for equal score and equal recency", () => {
    const pool = [
      item("second", "actions", "run one", { searchTerms: ["run"] }),
      item("first", "actions", "run two", { searchTerms: ["run"] }),
    ];
    expect(ids(rankItems(pool, "run"))).toEqual(["second", "first"]);
  });
  it("caps every group on its own and counts all matches", () => {
    const pool = [
      ...Array.from({ length: 70 }, (_, i) => item(`o${i}`, "open", `file ${i}`)),
      ...Array.from({ length: 3 }, (_, i) => item(`a${i}`, "actions", `file action ${i}`)),
      ...Array.from({ length: 55 }, (_, i) => item(`s${i}`, "sessions", `file session ${i}`)),
    ];
    const result = rankItems(pool, "file");
    expect([result.groups.map((g) => [g.group, g.items.length]), result.count]).toEqual([
      [
        ["open", 50],
        ["actions", 3],
        ["sessions", 50],
      ],
      128,
    ]);
  });
});
