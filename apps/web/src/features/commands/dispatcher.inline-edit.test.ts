// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "./defaults.ts";
import { installDispatcher } from "./dispatcher.ts";
import { registerCommand } from "./registry.ts";
import { mergeWithDefaults } from "./resolve.ts";

const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
let uninstall: () => void;
let cleanup: Array<() => void> = [];
beforeEach(() => {
  uninstall = installDispatcher({
    win: window,
    platform: "other",
    rules: () => rules,
    shell: () => ({ mobile: false, treeOpen: false }),
  });
});
afterEach(() => {
  uninstall();
  cleanup.forEach((fn) => fn());
  cleanup = [];
  document.body.innerHTML = "";
});

const escapeIn = (target: Element) => {
  const event = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

describe("the default Escape rule through the real dispatcher", () => {
  it("stops the run from a session pane, and never from inside an inline edit", () => {
    const stopRun = vi.fn();
    cleanup.push(registerCommand("session.stop", stopRun));
    const pane = document.createElement("section");
    pane.setAttribute("data-pane-kind", "session");
    const plain = document.createElement("button");
    const edit = document.createElement("div");
    edit.setAttribute("data-inline-edit", "");
    const inside = document.createElement("button");
    edit.append(inside);
    pane.append(plain, edit);
    document.body.append(pane);

    inside.focus();
    expect(escapeIn(inside).defaultPrevented).toBe(false);
    expect(stopRun).not.toHaveBeenCalled();

    plain.focus();
    expect(escapeIn(plain).defaultPrevented).toBe(true);
    expect(stopRun).toHaveBeenCalledOnce();
  });
});
