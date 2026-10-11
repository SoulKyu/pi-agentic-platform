import { UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession, type SessionView } from "./session-reducer.ts";

const snapshot = (fields: Record<string, unknown> = {}) => ({
  kind: "snapshot",
  status: "idle",
  rows: [],
  dialogs: [],
  hiddenDialogs: 0,
  partial: null,
  queue: { steering: [], followUp: [], count: 0, bytes: 0 },
  statuses: [],
  widgets: [],
  title: null,
  panels: [],
  notices: [],
  decorationsTruncated: false,
  history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
  activity: { compacting: false, retry: null },
  leafId: null,
  name: null,
  ...fields,
});
const run = (events: unknown[], from: SessionView = EMPTY_VIEW): SessionView =>
  events.reduce<SessionView>((view, event) => reduceSession(view, event), from);

describe("status bar", () => {
  it("sets, replaces in place, and clears a key", () => {
    const view = run([
      { kind: "status_bar", key: "git", text: "main" },
      { kind: "status_bar", key: "mode", text: "build" },
      { kind: "status_bar", key: "git", text: "dev" },
    ]);
    expect(view.statuses).toEqual([
      { key: "git", text: "dev" },
      { key: "mode", text: "build" },
    ]);
    expect(reduceSession(view, { kind: "status_bar", key: "git", text: null }).statuses).toEqual([
      { key: "mode", text: "build" },
    ]);
  });

  it("holds at most the contract's number of keys", () => {
    const events = Array.from({ length: UI_LIMITS.statuses + 3 }, (_, i) => ({
      kind: "status_bar",
      key: `k${i}`,
      text: "x",
    }));
    expect(run(events).statuses).toHaveLength(UI_LIMITS.statuses);
  });
});

describe("widgets, title, panels", () => {
  const widget = { key: "todo", lines: ["- a"], placement: "aboveEditor" };

  it("replaces a widget by key and removes it on null", () => {
    const view = run([
      { kind: "widget", key: "todo", widget },
      { kind: "widget", key: "todo", widget: { ...widget, lines: ["- b"] } },
    ]);
    expect(view.widgets).toEqual([{ ...widget, lines: ["- b"] }]);
    expect(reduceSession(view, { kind: "widget", key: "todo", widget: null }).widgets).toEqual([]);
  });

  it("sets and clears the title", () => {
    const view = run([{ kind: "title", title: "pi - repo" }]);
    expect(view.title).toBe("pi - repo");
    expect(reduceSession(view, { kind: "title", title: null }).title).toBeNull();
  });

  it("shows a panel, replaces it by id, then drops it on panel_closed", () => {
    const view = run([
      { kind: "panel", panel: { id: "p1", lines: ["a"] } },
      { kind: "panel", panel: { id: "p2", lines: ["x"] } },
      { kind: "panel", panel: { id: "p1", lines: ["b"] } },
    ]);
    expect(view.panels).toEqual([
      { id: "p1", lines: ["b"] },
      { id: "p2", lines: ["x"] },
    ]);
    const closed = reduceSession(view, { kind: "panel_closed", id: "p1" });
    expect(closed.panels).toEqual([{ id: "p2", lines: ["x"] }]);
    expect(reduceSession(closed, { kind: "panel_closed", id: "ghost" })).toBe(closed);
  });

  it("holds at most the contract's number of panels", () => {
    const events = Array.from({ length: UI_LIMITS.panels + 2 }, (_, i) => ({
      kind: "panel",
      panel: { id: `p${i}`, lines: ["a"] },
    }));
    expect(run(events).panels).toHaveLength(UI_LIMITS.panels);
  });
});

describe("editor text", () => {
  it("gives each event its own seq, even for the same text", () => {
    const one = run([{ kind: "editor_text", text: "prefill" }]);
    expect(one.editorText).toEqual({ text: "prefill", seq: 1 });
    const two = reduceSession(one, { kind: "editor_text", text: "prefill" });
    expect(two.editorText).toEqual({ text: "prefill", seq: 2 });
  });

  it("keeps counting across a snapshot and a cold status", () => {
    const view = run([{ kind: "editor_text", text: "a" }, snapshot(), { kind: "status", status: "cold" }]);
    expect(view.editorText).toEqual({ text: "a", seq: 1 });
    expect(reduceSession(view, { kind: "editor_text", text: "b" }).editorText?.seq).toBe(2);
  });
});

describe("snapshot and cold", () => {
  it("starts from the snapshot's decorations, notices and hidden dialogs", () => {
    const view = reduceSession(
      EMPTY_VIEW,
      snapshot({
        statuses: [{ key: "git", text: "main" }],
        widgets: [{ key: "todo", lines: ["a"], placement: "belowEditor" }],
        title: "t",
        panels: [{ id: "p1", lines: ["a"] }],
        notices: [{ level: "info", text: "hello", source: "extension" }],
        hiddenDialogs: 2,
      }),
    );
    expect(view).toMatchObject({
      statuses: [{ key: "git", text: "main" }],
      widgets: [{ key: "todo", lines: ["a"], placement: "belowEditor" }],
      title: "t",
      panels: [{ id: "p1", lines: ["a"] }],
      notices: [{ level: "info", text: "hello", source: "extension" }],
      hiddenDialogs: 2,
    });
  });

  it("clears statuses, widgets, title and panels when the session goes cold", () => {
    const live = run([
      { kind: "status_bar", key: "git", text: "main" },
      { kind: "widget", key: "todo", widget: { key: "todo", lines: ["a"], placement: "aboveEditor" } },
      { kind: "title", title: "t" },
      { kind: "panel", panel: { id: "p1", lines: ["a"] } },
    ]);
    expect(live).toMatchObject({ statuses: [expect.anything()], panels: [expect.anything()] });
    const cold = reduceSession(live, { kind: "status", status: "cold" });
    expect(cold).toMatchObject({ statuses: [], widgets: [], title: null, panels: [] });
  });

  it("keeps them while the session is only releasing", () => {
    const live = run([{ kind: "title", title: "t" }]);
    expect(reduceSession(live, { kind: "status", status: "releasing" }).title).toBe("t");
  });
});
