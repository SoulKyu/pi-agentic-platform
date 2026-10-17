import { describe, expect, it } from "vitest";
import { sizeOf } from "../../kernel/json-bytes.ts";
import { fitSnapshot } from "./snapshot.ts";

const approval = {
  id: "own",
  method: "approval" as const,
  title: "Run?",
  message: "m".repeat(300),
  category: "exec" as const,
  answers: ["deny", "once"] as Array<"deny" | "once">,
};
const child = (id: string) => ({
  id,
  runId: `run-${id}`,
  title: "t".repeat(60),
  profile: null,
  state: "running" as const,
  costUsd: 0,
  dialogs: [],
  hiddenDialogs: 0,
});
const input = (children: ReturnType<typeof child>[]) => ({
  status: "running" as const,
  rows: [],
  dialogs: [approval],
  children,
});
/** The smallest budget whose room (the budget less the rows' floor) is at least `room` bytes. */
const budgetFor = (room: number): number => Math.ceil((room * 16) / 15) + 16;

describe("the children's lines in a snapshot (Task 30 minor)", () => {
  const base = sizeOf(fitSnapshot({ ...input([]) }, 100_000));
  const line = sizeOf(child("c1")) + 1;

  it("counts every child in hiddenChildren when not even its line fits, and stays under the budget", () => {
    const budget = budgetFor(base + 10);
    const snapshot = fitSnapshot(input([child("c1"), child("c2")]), budget);
    expect(snapshot.children).toEqual([]);
    expect(snapshot.hiddenChildren).toBe(2);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(budget);
  });

  it("keeps the children whose line fits, in order, and counts the rest", () => {
    const budget = budgetFor(base + line + 10);
    const snapshot = fitSnapshot(input([child("c1"), child("c2"), child("c3")]), budget);
    expect(snapshot.children.map((each) => each.id)).toEqual(["c1"]);
    expect(snapshot.hiddenChildren).toBe(2);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(budget);
  });

  it("hides none when all fit", () => {
    const snapshot = fitSnapshot(input([child("c1"), child("c2")]), 100_000);
    expect(snapshot.children.map((each) => each.id)).toEqual(["c1", "c2"]);
    expect(snapshot.hiddenChildren).toBe(0);
  });
});
