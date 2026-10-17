import { describe, expect, it } from "vitest";
import { sessionSnapshot } from "../testing/session-snapshot.ts";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const child = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  runId: `run-${id}`,
  title: `Task ${id}`,
  profile: "scout",
  state: "running",
  costUsd: 0.5,
  dialogs: [],
  hiddenDialogs: 0,
  ...patch,
});

describe("the session view's subagents (M11R153)", () => {
  it("starts with none, and a snapshot without them (an older daemon) keeps none", () => {
    expect(EMPTY_VIEW.children).toEqual([]);
    expect(reduceSession(EMPTY_VIEW, sessionSnapshot()).children).toEqual([]);
  });

  it("takes the snapshot's children, with their open dialogs", () => {
    const dialog = { id: "d1", method: "confirm", title: "Run?", message: "ls" };
    const view = reduceSession(
      EMPTY_VIEW,
      sessionSnapshot({ children: [child("c1", { dialogs: [dialog] })] }),
    );
    expect(view.children).toHaveLength(1);
    expect(view.children[0]).toMatchObject({ id: "c1", runId: "run-c1", dialogs: [{ id: "d1" }] });
  });

  it("replaces the list on a subagents event, and a later snapshot replaces it again", () => {
    let view = reduceSession(EMPTY_VIEW, sessionSnapshot({ children: [child("c1")] }));
    view = reduceSession(view, {
      kind: "subagents",
      children: [child("c2"), child("c1", { state: "done" })],
    });
    expect(view.children.map((one) => [one.id, one.state])).toEqual([
      ["c2", "running"],
      ["c1", "done"],
    ]);
    view = reduceSession(view, sessionSnapshot({ children: [] }));
    expect(view.children).toEqual([]);
  });

  it("empties the list when the event says there are none", () => {
    const view = reduceSession(EMPTY_VIEW, sessionSnapshot({ children: [child("c1")] }));
    expect(reduceSession(view, { kind: "subagents", children: [] }).children).toEqual([]);
  });

  it("keeps them while the session goes cold: a child outlives its parent's worker", () => {
    const view = reduceSession(EMPTY_VIEW, sessionSnapshot({ children: [child("c1")] }));
    expect(reduceSession(view, { kind: "status", status: "cold" }).children).toHaveLength(1);
  });

  it("drops an event it cannot read, and keeps the view", () => {
    const view = reduceSession(EMPTY_VIEW, sessionSnapshot({ children: [child("c1")] }));
    const noRun = { ...child("c2"), runId: undefined };
    expect(reduceSession(view, { kind: "subagents", children: [noRun] })).toBe(view);
  });
});
