import { describe, expect, it } from "vitest";
import { createPendingBudget } from "./pending-budget.ts";

const MIB = 1024 * 1024;
const limits = { count: 32, bytes: 200 * MIB };

describe("createPendingBudget (M8R37)", () => {
  it("refuses the 33rd kept reservation of one owner and leaves another owner alone", () => {
    const budget = createPendingBudget(limits);
    for (let i = 0; i < 32; i++) budget.reserve("u1", 1)?.keep();
    expect(budget.reserve("u1", 1)).toBeNull();
    expect(budget.reserve("u2", 1)).not.toBeNull();
  });

  it("frees one place on release", () => {
    const budget = createPendingBudget(limits);
    for (let i = 0; i < 32; i++) budget.reserve("u1", 1)?.keep();
    budget.release("u1", 1);
    expect(budget.reserve("u1", 1)).not.toBeNull();
    expect(budget.reserve("u1", 1)).toBeNull();
  });

  it("counts the bytes of uploads still arriving: the fourth of 60 MiB does not fit until one is cancelled", () => {
    const budget = createPendingBudget(limits);
    const held = [1, 2, 3].map(() => budget.reserve("u1", 60 * MIB));
    expect(held.every((reservation) => reservation !== null)).toBe(true);
    expect(budget.reserve("u1", 60 * MIB)).toBeNull();
    held[0]?.cancel();
    expect(budget.reserve("u1", 60 * MIB)).not.toBeNull();
  });

  it("accepts exactly the byte cap and refuses one byte more", () => {
    const budget = createPendingBudget(limits);
    budget.reserve("u1", 200 * MIB)?.keep();
    expect(budget.reserve("u1", 1)).toBeNull();
  });

  it("cancels exactly once, and not at all after keep", () => {
    const budget = createPendingBudget({ count: 2, bytes: 100 });
    const first = budget.reserve("u1", 10);
    const second = budget.reserve("u1", 10);
    expect(budget.reserve("u1", 10)).toBeNull();
    first?.cancel();
    first?.cancel();
    expect(budget.reserve("u1", 10)).not.toBeNull();
    expect(budget.reserve("u1", 10)).toBeNull();
    second?.keep();
    second?.cancel();
    expect(budget.reserve("u1", 10)).toBeNull();
  });
});
