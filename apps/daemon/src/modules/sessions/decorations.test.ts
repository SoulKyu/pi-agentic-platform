import { UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createDecorations } from "./decorations.ts";

const req = (method: string, fields: Record<string, unknown> = {}) => ({
  type: "extension_ui_request" as const,
  id: "x",
  method,
  ...fields,
});

describe("decorations", () => {
  it("rebuilds status, widget, title and editor-text events from the fields it knows, cut", () => {
    const d = createDecorations();
    expect(d.apply(req("setStatus", { statusKey: "command:/mode build", statusText: "Build" }))).toEqual({
      kind: "status_bar",
      key: "command:/mode build",
      text: "Build",
    });
    expect(d.apply(req("setStatus", { statusKey: "git", statusText: "m".repeat(9000) }))).toEqual({
      kind: "status_bar",
      key: "git",
      text: "m".repeat(UI_LIMITS.statusText),
    });
    expect(
      d.apply(
        req("setWidget", { widgetKey: "todo", widgetLines: ["- a", 7], widgetPlacement: "belowEditor" }),
      ),
    ).toBeNull();
    expect(
      d.apply(req("setWidget", { widgetKey: "todo", widgetLines: ["- a"], widgetPlacement: "sideways" })),
    ).toEqual({
      kind: "widget",
      key: "todo",
      widget: { key: "todo", lines: ["- a"], placement: "aboveEditor" },
    });
    expect(d.apply(req("setTitle", { title: "pi - repo" }))).toEqual({ kind: "title", title: "pi - repo" });
    expect(d.apply(req("set_editor_text", { text: "prefill" }))).toEqual({
      kind: "editor_text",
      text: "prefill",
    });
    expect(d.apply(req("notify", { message: "saved", notifyType: "loud" }))).toEqual({
      kind: "notice",
      level: "info",
      text: "saved",
    });
    expect(d.statuses()).toEqual([
      { key: "command:/mode build", text: "Build" },
      { key: "git", text: "m".repeat(UI_LIMITS.statusText) },
    ]);
    expect(d.widgets()).toEqual([{ key: "todo", lines: ["- a"], placement: "aboveEditor" }]);
    expect(d.title()).toBe("pi - repo");
  });

  it("maps notify types, cuts texts and widget lines, and does not store an editor text", () => {
    const d = createDecorations();
    expect(d.apply(req("notify", { message: "x", notifyType: "warning" }))).toMatchObject({
      level: "warning",
    });
    expect(d.apply(req("notify", { message: "x", notifyType: "error" }))).toMatchObject({ level: "error" });
    expect(d.apply(req("notify", { message: "é".repeat(5000) }))).toEqual({
      kind: "notice",
      level: "info",
      text: "é".repeat(UI_LIMITS.noticeText),
    });
    const lines = Array.from({ length: UI_LIMITS.widgetLines + 5 }, () =>
      "w".repeat(UI_LIMITS.widgetLineChars + 5),
    );
    const widget = d.apply(req("setWidget", { widgetKey: "w", widgetLines: lines }));
    expect(widget).toMatchObject({ kind: "widget" });
    expect(d.widgets()[0]?.lines).toHaveLength(UI_LIMITS.widgetLines);
    expect(d.widgets()[0]?.lines[0]).toBe("w".repeat(UI_LIMITS.widgetLineChars));
    expect(d.apply(req("setTitle", { title: "t".repeat(999) }))).toEqual({
      kind: "title",
      title: "t".repeat(UI_LIMITS.title),
    });
    d.apply(req("set_editor_text", { text: "prefill" }));
    expect(d.statuses()).toEqual([]);
  });

  it("refuses what it cannot rebuild", () => {
    const d = createDecorations();
    const bad = [
      req("setStatus"),
      req("setStatus", { statusKey: "", statusText: "x" }),
      req("setStatus", { statusKey: 4, statusText: "x" }),
      req("setStatus", { statusKey: "k".repeat(UI_LIMITS.statusKey + 1), statusText: "x" }),
      req("setWidget", { widgetKey: "w", widgetLines: "not an array" }),
      req("setWidget", { widgetLines: ["a"] }),
      req("setTitle", { title: 4 }),
      req("set_editor_text", { text: 4 }),
      req("notify", { message: 4 }),
      req("notify"),
      req("select"),
    ];
    for (const request of bad) expect(d.apply(request)).toBeNull();
    expect(d.statuses()).toEqual([]);
    expect(d.widgets()).toEqual([]);
    expect(d.title()).toBeNull();
  });

  it("clears a status or widget given no content, and drops new keys past the limits", () => {
    const d = createDecorations();
    for (let i = 0; i < UI_LIMITS.statuses; i++)
      d.apply(req("setStatus", { statusKey: `k${i}`, statusText: "x" }));
    expect(d.apply(req("setStatus", { statusKey: "one-too-many", statusText: "x" }))).toBeNull();
    expect(d.apply(req("setStatus", { statusKey: "k0" }))).toEqual({
      kind: "status_bar",
      key: "k0",
      text: null,
    });
    expect(d.statuses()).toHaveLength(UI_LIMITS.statuses - 1);
    expect(d.apply(req("setStatus", { statusKey: "one-too-many", statusText: "x" }))).not.toBeNull();
    for (let i = 0; i < UI_LIMITS.widgets; i++)
      d.apply(req("setWidget", { widgetKey: `w${i}`, widgetLines: ["a"] }));
    expect(d.apply(req("setWidget", { widgetKey: "extra", widgetLines: ["a"] }))).toBeNull();
    expect(d.apply(req("setWidget", { widgetKey: "w0" }))).toEqual({
      kind: "widget",
      key: "w0",
      widget: null,
    });
    expect(d.widgets()).toHaveLength(UI_LIMITS.widgets - 1);
    expect(d.apply(req("setStatus", { statusKey: "k1", statusText: "y" }))).not.toBeNull();
  });

  it("clear() forgets statuses, widgets and the title", () => {
    const d = createDecorations();
    d.apply(req("setStatus", { statusKey: "k", statusText: "x" }));
    d.apply(req("setWidget", { widgetKey: "w", widgetLines: ["a"] }));
    d.apply(req("setTitle", { title: "t" }));
    d.clear();
    expect([d.statuses(), d.widgets(), d.title()]).toEqual([[], [], null]);
  });
});
