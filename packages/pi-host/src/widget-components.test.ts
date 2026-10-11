import { UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { ANSI_THEME } from "./ansi-theme.ts";
import { createWidgetComponents } from "./widget-components.ts";

function setup() {
  const sent: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const due: Array<() => void> = [];
  let ids = 0;
  const widgets = createWidgetComponents(
    (record) => {
      sent.push(record);
      return true;
    },
    {
      newId: () => `w${++ids}`,
      theme: ANSI_THEME,
      onError: (event) => void errors.push(event),
      timers: {
        setTimer: (fn) => {
          due.push(fn);
          return fn;
        },
        clearTimer: (handle) => {
          const at = due.indexOf(handle as never);
          if (at !== -1) due.splice(at, 1);
        },
      },
    },
  );
  return { sent, errors, due, widgets };
}

describe("widget components", () => {
  it("renders a factory widget at 92 columns, coalesces requestRender, disposes on replacement and clear", () => {
    const { sent, due, widgets } = setup();
    let lines = ["- a"];
    let requestRender = () => {};
    const widths: number[] = [];
    const disposed: string[] = [];
    const make = (name: string) => (tui: { requestRender(): void }) => {
      requestRender = () => tui.requestRender();
      return {
        render: (width: number) => {
          widths.push(width);
          return lines;
        },
        invalidate: () => {},
        dispose: () => disposed.push(name),
      };
    };
    widgets.set("todo", make("first") as never, "belowEditor");
    expect(sent).toEqual([
      {
        type: "extension_ui_request",
        id: "w1",
        method: "setWidget",
        widgetKey: "todo",
        widgetLines: ["- a"],
        widgetPlacement: "belowEditor",
      },
    ]);
    expect(widths).toEqual([92]);
    lines = ["- b"];
    for (let i = 0; i < 60; i++) requestRender();
    expect(sent).toHaveLength(1);
    expect(due).toHaveLength(1);
    due.splice(0)[0]?.();
    expect(sent.at(-1)).toMatchObject({ method: "setWidget", widgetKey: "todo", widgetLines: ["- b"] });
    expect(sent).toHaveLength(2);

    requestRender();
    widgets.set("todo", make("second") as never, "belowEditor");
    expect(disposed).toEqual(["first"]);
    expect(due).toEqual([]);

    widgets.clear("todo");
    expect(disposed).toEqual(["first", "second"]);
    expect(sent.at(-1)).toMatchObject({ method: "setWidget", widgetKey: "todo", widgetLines: undefined });
    requestRender();
    expect(due).toEqual([]);
  });

  it("reports a throwing factory and sends nothing", () => {
    const { sent, errors, widgets } = setup();
    widgets.set("x", (() => {
      throw new Error("no");
    }) as never);
    expect(errors).toEqual(["setWidget"]);
    expect(sent).toEqual([]);
  });

  it("reports a throwing render, disposes the component and sends nothing", () => {
    const { sent, errors, widgets } = setup();
    let disposed = false;
    widgets.set("x", (() => ({
      render: () => {
        throw new Error("no");
      },
      dispose: () => (disposed = true),
    })) as never);
    expect(errors).toEqual(["setWidget"]);
    expect(disposed).toBe(true);
    expect(sent).toEqual([]);
  });

  it("cuts and sanitises lines, and refuses a widget beyond the cap", () => {
    const { sent, errors, widgets } = setup();
    widgets.set("big", (() => ({
      render: () => Array.from({ length: 80 }, () => "\u001b]0;t\u0007" + "z".repeat(900)),
    })) as never);
    const lines = (sent[0] as { widgetLines: string[] }).widgetLines;
    expect(lines).toHaveLength(UI_LIMITS.widgetLines);
    expect(lines[0]).toBe("z".repeat(UI_LIMITS.widgetLineChars));
    for (let i = 0; i < UI_LIMITS.widgets; i++)
      widgets.set(`k${i}`, (() => ({ render: () => ["x"] })) as never);
    expect(errors).toEqual(["setWidget"]);
    const before = sent.length;
    widgets.set("one-too-many", (() => ({ render: () => ["x"] })) as never);
    expect(sent).toHaveLength(before);
    expect(errors).toEqual(["setWidget", "setWidget"]);
    widgets.clearAll();
    expect(sent.filter((r) => r.widgetLines === undefined)).toHaveLength(UI_LIMITS.widgets);
  });
});
