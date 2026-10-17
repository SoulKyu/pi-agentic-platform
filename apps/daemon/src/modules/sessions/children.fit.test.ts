import type { ChildSummary, Dialog } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { fitChildren } from "./children.ts";

const summary = (id: string): ChildSummary => ({
  id,
  runId: `run-${id}`,
  title: `Task of ${id}`,
  profile: null,
  state: "running",
  costUsd: 0.5,
});

describe("fitChildren keeps the event under its budget", () => {
  const dialog = (id: string, method: Dialog["method"], size: number): Dialog =>
    method === "approval"
      ? { id, method, title: "Run?", message: "m".repeat(size), category: "exec", answers: ["deny", "once"] }
      : { id, method, title: "t", prefill: "p".repeat(size) };

  it("keeps approvals first, drops what does not fit and counts it", () => {
    const [view] = fitChildren(
      [
        {
          ...summary("c1"),
          dialogs: [
            dialog("i1", "editor", 200_000),
            dialog("a1", "approval", 60_000),
            dialog("a2", "approval", 60_000),
            dialog("a3", "approval", 60_000),
          ],
        },
      ],
      200_000,
    );
    expect(view?.dialogs.map((each) => each.id)).toEqual(["a1", "a2", "a3"]);
    expect(view?.hiddenDialogs).toBe(1);
  });

  it("gives an approval the room before an input dialog that came first", () => {
    const [view] = fitChildren(
      [
        {
          ...summary("c1"),
          dialogs: [
            dialog("i1", "editor", 100_000),
            dialog("a1", "approval", 60_000),
            dialog("a2", "approval", 60_000),
          ],
        },
      ],
      200_000,
    );
    expect(view?.dialogs.map((each) => each.id)).toEqual(["a1", "a2"]);
    expect(view?.hiddenDialogs).toBe(1);
  });

  it("shares the budget between children in order", () => {
    const views = fitChildren(
      [
        { ...summary("c1"), dialogs: [dialog("a1", "approval", 60_000)] },
        { ...summary("c2"), dialogs: [dialog("a2", "approval", 60_000)] },
      ],
      70_000,
    );
    expect(views.map((view) => [view.dialogs.length, view.hiddenDialogs])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});
