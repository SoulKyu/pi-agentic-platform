import { describe, expect, it } from "vitest";
import { compareCodePoints, RANK_BUDGET_CELLS, RANK_MAX_PATHS, RANK_TAIL_CHARS, rank } from "./rank.ts";

describe("rank", () => {
  it("puts the subsequence match with runs and segment starts first", () => {
    const paths = ["docs/server-index-notes.md", "src/server/index.ts"];
    expect(rank(paths, "srvidx", 50).paths).toEqual(["src/server/index.ts", "docs/server-index-notes.md"]);
    // The letters spread over the middle of words score below the same letters at word starts and in runs.
    expect(rank(["lib/xsxrxvxixdxx.ts", "src/server/index.ts"], "srvidx", 50).paths[0]).toBe(
      "src/server/index.ts",
    );
  });

  it("ranks an exact basename before a longer path that merely contains the letters", () => {
    const paths = ["src/application/main.ts", "lib/app.ts", "src/appx.ts", "app.ts"];
    expect(rank(paths, "app.ts", 50).paths.slice(0, 2)).toEqual(["app.ts", "lib/app.ts"]);
  });

  it("ignores case, and drops what is not a subsequence", () => {
    expect(rank(["README.md", "src/readme.txt", "src/main.ts"], "READ", 50).paths).toEqual([
      "README.md",
      "src/readme.txt",
    ]);
    expect(rank(["abc"], "acb", 50)).toMatchObject({ paths: [], more: false });
  });

  it("answers at most the limit and says when more matched", () => {
    const paths = Array.from({ length: 80 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    const answer = rank(paths, "f", 50);
    expect(answer.paths).toHaveLength(50);
    expect(answer.more).toBe(true);
    expect(rank(paths, "f", 80).more).toBe(false);
  });

  it("breaks a tie by length, then by code point", () => {
    expect(rank(["b/x", "a/x", "A/x", "ab/x"], "x", 50).paths).toEqual(["A/x", "a/x", "b/x", "ab/x"]);
    expect(compareCodePoints("Ａ", "\u{1F600}")).toBeLessThan(0);
    expect(compareCodePoints("a", "a")).toBe(0);
  });

  it("answers nothing for an empty index", () => {
    expect(rank([], "x", 50)).toMatchObject({ paths: [], more: false });
  });

  it("leaves out what the predicate refuses and fills the limit with the rest", () => {
    const answer = rank(["a/1.ts", "a/2.ts", "a/3.ts"], "ts", 2, (path) => path !== "a/1.ts");
    expect(answer).toMatchObject({ paths: ["a/2.ts", "a/3.ts"], more: false });
  });

  it("scores only the last characters of a very long path", () => {
    const long = `${"a/".repeat(2000)}server/index.ts`;
    expect(rank([long], "srvidx", 5).paths).toEqual([long]);
    // A letter that only the discarded head holds does not match.
    expect(rank([`x${"b".repeat(RANK_TAIL_CHARS + 10)}`], "x", 5).paths).toEqual([]);
  });

  it("stops past a per-search budget of cells and says more was left", () => {
    const paths = Array.from({ length: 10 }, (_, i) => `abcdefghij${i}`);
    const full = rank(paths, "ace", 50, () => true, 1_000_000);
    expect(full.paths).toHaveLength(10);
    expect(full.more).toBe(false);
    const cut = rank(paths, "ace", 50, () => true, 25);
    expect(cut.more).toBe(true);
    expect(cut.paths.length).toBeGreaterThan(0);
    expect(cut.paths.length).toBeLessThan(10);
    expect(cut.paths).toEqual(paths.slice(0, cut.paths.length).sort());
  });

  it("bounds the work on crafted input: 2 000 paths of 4 KB and a 128-character query", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const crafted = Array.from({ length: 2000 }, (_, i) => `${alphabet.repeat(160)}${i}`.slice(0, 4096));
    const answer = rank(crafted, alphabet.repeat(5).slice(0, 128), 50);
    expect(answer.cells).toBeLessThanOrEqual(RANK_BUDGET_CELLS + RANK_TAIL_CHARS * 128);
    expect(answer.more).toBe(true);
  });

  it("finds an exact file name in an ordinary 100 000-path index without running out of budget (N1)", () => {
    const index = Array.from(
      { length: 100_000 },
      (_, i) => `packages/app${i % 50}/src/modules/module${i % 100}/file${i}.ts`,
    );
    const answer = rank(index, "file77777.ts", 50);
    expect(answer.paths).toEqual(["packages/app27/src/modules/module77/file77777.ts"]);
    expect(answer.more).toBe(false);
    // Paths the quick check rejects cost nothing: far under the budget.
    expect(answer.cells).toBeLessThan(RANK_BUDGET_CELLS / 10);
  });

  it("visits at most RANK_MAX_PATHS paths and says more was left", () => {
    expect(RANK_MAX_PATHS).toBeGreaterThanOrEqual(100_000);
    const answer = rank(["a/x", "a/y", "a/z"], "x", 5, () => true, RANK_BUDGET_CELLS, 2);
    expect(answer).toMatchObject({ paths: ["a/x"], more: true });
  });
});
