import { NO_TAINT } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createExternalRoots, createTaint } from "./taint.ts";

describe("taint", () => {
  it("raises, keeps the flag on a stale update, and lowers it only on a newer epoch (M5R6)", () => {
    const reports: number[] = [];
    const t = createTaint({ tainted: false, epoch: 0 }, () => void reports.push(1));
    expect(t.raise()).toBe(true);
    expect(reports).toHaveLength(1);
    expect(t.raise()).toBe(false);
    t.apply({ tainted: false, epoch: 0 });
    expect(t.current()).toBe(true);
    t.apply({ tainted: false, epoch: 1 });
    expect(t.state()).toEqual({ tainted: false, epoch: 1 });
    t.apply({ tainted: true, epoch: 1 });
    expect(t.current()).toBe(true);
    t.apply({ tainted: false, epoch: 0 });
    expect(t.state()).toEqual({ tainted: true, epoch: 1 });
    // `apply` never reports: the daemon sent it (M5R122).
    expect(reports).toHaveLength(1);
  });

  it("keeps a taint raised in the worker when a push from the daemon, built before it knew, arrives", () => {
    const t = createTaint(NO_TAINT, () => {});
    t.raise();
    t.apply({ tainted: false, epoch: 0 });
    expect(t.state()).toEqual({ tainted: true, epoch: 0 });
  });

  it("starts from what init says, tainted included", () => {
    expect(createTaint({ tainted: true, epoch: 3 }, () => {}).state()).toEqual({ tainted: true, epoch: 3 });
  });
});

describe("taint causes (decision 117, A3)", () => {
  const cause = { tool: "todo", source: "/x/todo.ts", markable: true } as const;

  it("records each raise, newest last, with the clock", () => {
    let now = 5;
    const t = createTaint(
      NO_TAINT,
      () => {},
      () => now++,
    );
    t.raise(cause);
    t.raise({ ...cause, tool: "other" });
    expect(t.causes().list.map((entry) => [entry.tool, entry.at])).toEqual([
      ["todo", 5],
      ["other", 6],
    ]);
  });

  it("gives a tool called many times one entry with its count and its newest time", () => {
    let now = 1;
    const t = createTaint(
      NO_TAINT,
      () => {},
      () => now++,
    );
    for (let i = 0; i < 20; i++) t.raise(cause);
    t.raise({ ...cause, tool: "other" });
    t.raise(cause);
    expect(t.causes()).toEqual({
      list: [
        { ...cause, tool: "other", at: 21, count: 1 },
        { ...cause, at: 22, count: 21 },
      ],
      older: 0,
    });
  });

  // APR-8: a taint the card did not fully name can never be lifted from the card.
  it("makes every entry not markable once a not markable cause was seen, whatever came after", () => {
    const t = createTaint(NO_TAINT, () => {});
    t.raise({ tool: "web_search", source: "builtin:web_search", markable: false });
    for (let i = 0; i < 9; i++) t.raise({ ...cause, tool: `ext${i}`, source: `/x/ext${i}.ts` });
    const { list, older } = t.causes();
    expect(list).toHaveLength(8);
    expect(older).toBe(2);
    expect(list.every((entry) => !entry.markable)).toBe(true);
  });

  it("makes every entry not markable once an entry was dropped, though each one was markable", () => {
    const t = createTaint(NO_TAINT, () => {});
    for (let i = 0; i < 9; i++) t.raise({ ...cause, tool: `ext${i}`, source: `/x/ext${i}.ts` });
    expect(t.causes().older).toBe(1);
    expect(t.causes().list.every((entry) => !entry.markable)).toBe(true);
  });

  it("makes every entry not markable after a raise that named no cause", () => {
    const t = createTaint(NO_TAINT, () => {});
    t.raise(cause);
    t.raise();
    expect(t.causes().list.map((entry) => entry.markable)).toEqual([false]);
  });

  it("keeps markable entries markable when nothing else was seen, and forgets the bit on a clear", () => {
    const t = createTaint(NO_TAINT, () => {});
    t.raise(cause);
    expect(t.causes().list.map((entry) => entry.markable)).toEqual([true]);
    t.raise({ tool: "web_search", source: "builtin:web_search", markable: false });
    t.apply({ tainted: false, epoch: 1 });
    t.raise(cause);
    expect(t.causes().list.map((entry) => entry.markable)).toEqual([true]);
  });

  it("forgets the causes on a clear (a newer epoch)", () => {
    const t = createTaint(NO_TAINT, () => {});
    t.raise(cause);
    t.apply({ tainted: false, epoch: 1 });
    expect(t.causes()).toEqual({ list: [], older: 0 });
    t.raise(cause);
    expect(t.causes().list).toHaveLength(1);
  });

  it("names no cause for a taint it did not see rise (init, or a daemon update): the list would be partial", () => {
    const born = createTaint({ tainted: true, epoch: 2 }, () => {});
    born.raise(cause);
    expect(born.causes().list).toEqual([]);
    const pushed = createTaint(NO_TAINT, () => {});
    pushed.raise(cause);
    pushed.apply({ tainted: true, epoch: 1 });
    expect(pushed.causes().list).toEqual([]);
    pushed.apply({ tainted: false, epoch: 2 });
    pushed.raise(cause);
    expect(pushed.causes().list).toHaveLength(1);
  });
});

describe("external roots", () => {
  it("takes a root out once", () => {
    const roots = createExternalRoots();
    roots.add("p");
    expect(roots.take("p")).toBe(true);
    expect(roots.take("p")).toBe(false);
  });

  it("clears, and stays at 1000 roots with the oldest dropped", () => {
    const roots = createExternalRoots();
    for (let i = 0; i < 1001; i++) roots.add(`p${i}`);
    expect(roots.take("p0")).toBe(false);
    expect(roots.take("p1")).toBe(true);
    expect(roots.take("p1000")).toBe(true);
    roots.add("q");
    roots.clear();
    expect(roots.take("q")).toBe(false);
  });
});
