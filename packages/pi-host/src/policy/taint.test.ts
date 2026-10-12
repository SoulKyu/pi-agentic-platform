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
