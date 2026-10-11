// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportClientIssue } from "../../lib/report.ts";
import { installDispatcher } from "./dispatcher.ts";
import { registerCommand } from "./registry.ts";
import { mergeWithDefaults } from "./resolve.ts";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const known = new Set(["palette.toggle", "shortcuts.help", "drawer.tree.toggle", "session.stop"]);
const { rules } = mergeWithDefaults(
  [
    { key: "mod+k", command: "palette.toggle", when: "!panelFocus" },
    { key: "mod+b", command: "drawer.tree.toggle", when: "!panelFocus && (!dialogOpen || treeOpen)" },
    { key: "?", command: "shortcuts.help", when: "!panelFocus && !editableFocus && !dialogOpen" },
    {
      key: "escape",
      command: "session.stop",
      when: "sessionFocus && !panelFocus && !overlayOpen && !dialogOpen && !paletteOpen",
    },
  ],
  [],
  known,
);
const shell = { mobile: false, treeOpen: false };
const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

let stop: () => void;
let cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.mocked(reportClientIssue).mockClear();
  stop = installDispatcher({ win: window, platform: "other", rules: () => rules, shell: () => shell });
});
afterEach(() => {
  stop();
  cleanup.forEach((fn) => fn());
  cleanup = [];
  document.body.innerHTML = "";
});

describe("key dispatcher", () => {
  it("runs the command's handler and keeps the key from the page", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    const event = press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a key alone when nobody claims it, or the handler declines", () => {
    expect(press({ key: "k", code: "KeyK", ctrlKey: true }).defaultPrevented).toBe(false);
    cleanup.push(registerCommand("palette.toggle", () => false));
    expect(press({ key: "k", code: "KeyK", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("does nothing during a composition, for auto-repeat, inside the recorder or after another handler", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    press({ key: "k", code: "KeyK", ctrlKey: true, isComposing: true });
    press({ key: "k", code: "KeyK", ctrlKey: true, repeat: true });
    const recorder = document.createElement("button");
    recorder.setAttribute("data-shortcut-recorder", "");
    document.body.append(recorder);
    press({ key: "k", code: "KeyK", ctrlKey: true }, recorder);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reads the context from the page: a modal blocks mod+b, a text field blocks ?", () => {
    const tree = vi.fn();
    const help = vi.fn();
    cleanup.push(registerCommand("drawer.tree.toggle", tree), registerCommand("shortcuts.help", help));
    const modal = document.createElement("div");
    modal.setAttribute("data-pap-modal", "");
    modal.setAttribute("data-state", "open");
    document.body.append(modal);
    press({ key: "b", code: "KeyB", ctrlKey: true });
    modal.remove();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    press({ key: "?", code: "Slash", shiftKey: true }, input);
    expect([tree.mock.calls.length, help.mock.calls.length]).toEqual([0, 0]);
    input.blur();
    press({ key: "?", code: "Slash", shiftKey: true });
    expect(help).toHaveBeenCalledOnce();
  });

  it("leaves a key another handler already took (defaultPrevented) alone", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    // Listeners on one target run in registration order: put a capture listener before the dispatcher.
    stop();
    const first = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", first, { capture: true });
    stop = installDispatcher({ win: window, platform: "other", rules: () => rules, shell: () => shell });
    press({ key: "k", code: "KeyK", ctrlKey: true });
    window.removeEventListener("keydown", first, { capture: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("gives Escape to an open menu or select, and to an extension's panel; stops the run otherwise (agreement 7)", () => {
    const stopRun = vi.fn();
    cleanup.push(registerCommand("session.stop", stopRun));
    const pane = document.createElement("section");
    pane.setAttribute("data-pane-kind", "session");
    const button = document.createElement("button");
    const panel = document.createElement("div");
    panel.setAttribute("data-terminal-input", "");
    const field = document.createElement("textarea");
    panel.append(field);
    pane.append(button, panel);
    document.body.append(pane);
    button.focus();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(press({ key: "Escape", code: "Escape" }, button).defaultPrevented).toBe(false);
    menu.remove();
    field.focus();
    expect(press({ key: "Escape", code: "Escape" }, field).defaultPrevented).toBe(false);
    expect(press({ key: "k", code: "KeyK", ctrlKey: true }, field).defaultPrevented).toBe(false);
    button.focus();
    expect(press({ key: "Escape", code: "Escape" }, button).defaultPrevented).toBe(true);
    expect(stopRun).toHaveBeenCalledOnce();
  });

  it("treats an open Radix popper (not a tooltip) as an overlay", () => {
    const stopRun = vi.fn();
    cleanup.push(registerCommand("session.stop", stopRun));
    const pane = document.createElement("section");
    pane.setAttribute("data-pane-kind", "session");
    const button = document.createElement("button");
    pane.append(button);
    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    popper.innerHTML = "<div>content</div>";
    document.body.append(pane, popper);
    button.focus();
    expect(press({ key: "Escape", code: "Escape" }, button).defaultPrevented).toBe(false);
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("ignores an open tooltip when it decides whether an overlay is open", () => {
    const stopRun = vi.fn();
    cleanup.push(registerCommand("session.stop", stopRun));
    const pane = document.createElement("section");
    pane.setAttribute("data-pane-kind", "session");
    const button = document.createElement("button");
    pane.append(button);
    const tip = document.createElement("div");
    tip.setAttribute("data-radix-popper-content-wrapper", "");
    tip.innerHTML = '<div><span role="tooltip">Stop</span></div>';
    document.body.append(pane, tip);
    button.focus();
    press({ key: "Escape", code: "Escape" }, button);
    expect(stopRun).toHaveBeenCalledOnce();
  });

  it("survives a throwing handler: logs a bounded code, leaves the key to the page, keeps working", () => {
    const boom = registerCommand("palette.toggle", () => {
      throw new Error("secret user text");
    });
    const event = press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(reportClientIssue).toHaveBeenCalledWith("command_failed");
    boom();
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("stops listening when stopped", () => {
    const handler = vi.fn();
    cleanup.push(registerCommand("palette.toggle", handler));
    stop();
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    stop = () => {};
  });
});
