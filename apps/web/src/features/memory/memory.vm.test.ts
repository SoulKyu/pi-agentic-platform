import { describe, expect, it } from "vitest";
import {
  correctionCounter,
  decideOutcome,
  filterItems,
  pruneSelection,
  scopeKey,
  sourceLabel,
  toggleSelection,
} from "./memory.vm.ts";

const items = [
  { id: "m1", text: "Likes Green Tea", createdAt: null, source: "agent" },
  { id: "m2", text: "Lives in Lyon", createdAt: "2026-10-01T00:00:00Z", source: "pi-web" },
  { id: "m3", text: "tea at five", createdAt: null, source: null },
];

describe("filterItems", () => {
  it("keeps everything for an empty or blank query", () => {
    expect(filterItems(items, "")).toHaveLength(3);
    expect(filterItems(items, "   ")).toHaveLength(3);
  });
  it("matches the text without case, trimmed", () => {
    expect(filterItems(items, "  TEA ").map((item) => item.id)).toEqual(["m1", "m3"]);
  });
  it("matches nothing else than the text (not the id, not the source)", () => {
    expect(filterItems(items, "m2")).toEqual([]);
    expect(filterItems(items, "pi-web")).toEqual([]);
  });
});

describe("selection", () => {
  it("toggles an id without touching the set it was given", () => {
    const first = new Set<string>();
    const second = toggleSelection(first, "m1");
    expect([...first]).toEqual([]);
    expect([...second]).toEqual(["m1"]);
    expect([...toggleSelection(second, "m1")]).toEqual([]);
  });
  it("refuses a 51st id (memory.forget takes 50) but still lets one go", () => {
    let picked: ReadonlySet<string> = new Set();
    for (let index = 0; index < 51; index++) picked = toggleSelection(picked, `m${index}`);
    expect(picked.size).toBe(50);
    expect(picked.has("m50")).toBe(false);
    expect(toggleSelection(picked, "m0").size).toBe(49);
  });

  it("drops ids the list no longer holds", () => {
    expect([...pruneSelection(new Set(["m1", "gone"]), items)]).toEqual(["m1"]);
  });
});

describe("correctionCounter", () => {
  it("counts the characters against 4 096", () => {
    expect(correctionCounter("abc")).toEqual({ used: 3, max: 4096, over: false, empty: false });
  });
  it("is over one character past the limit, and empty for blanks", () => {
    expect(correctionCounter("x".repeat(4096)).over).toBe(false);
    expect(correctionCounter("x".repeat(4097)).over).toBe(true);
    expect(correctionCounter("  \n").empty).toBe(true);
  });
});

describe("scopeKey", () => {
  it("tells the three kinds apart", () => {
    expect(scopeKey({ kind: "user" })).toBe("user");
    expect(scopeKey({ kind: "project", id: "p1" })).toBe("project:p1");
    expect(scopeKey({ kind: "agent", id: "atlas-1a2b" })).toBe("agent:atlas-1a2b");
  });
});

describe("decideOutcome", () => {
  it("reads conflict as being applied and not_found as already handled (both settle the row)", () => {
    expect(decideOutcome("conflict")).toEqual({ key: "memory.review.applying", settled: true });
    expect(decideOutcome("not_found")).toEqual({ key: "memory.review.handled", settled: true });
  });
  it("leaves any other failure as an error that keeps the row", () => {
    expect(decideOutcome("command_failed")).toEqual({ key: null, settled: false });
  });
});

describe("sourceLabel (C3)", () => {
  it("maps every token pi-mem0 writes to a catalog key", () => {
    expect(sourceLabel("staged")).toEqual({ key: "memory.source.staged" });
    expect(sourceLabel("memory_save")).toEqual({ key: "memory.source.memory_save" });
    expect(sourceLabel("auto")).toEqual({ key: "memory.source.auto" });
    expect(sourceLabel("pi-web")).toEqual({ key: "memory.source.pi-web" });
    expect(sourceLabel("agent")).toEqual({ key: "memory.source.agent" });
    expect(sourceLabel("user")).toEqual({ key: "memory.source.user" });
  });
  it("falls back to the raw token for an unknown source, never to a prototype key", () => {
    expect(sourceLabel("import")).toEqual({ key: "memory.item.source", params: { source: "import" } });
    expect(sourceLabel("constructor")).toEqual({
      key: "memory.item.source",
      params: { source: "constructor" },
    });
  });
});
