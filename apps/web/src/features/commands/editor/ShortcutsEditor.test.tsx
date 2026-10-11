// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, field, press, text, typeInto } from "../../../testing/dom.ts";
import { installDispatcher } from "../dispatcher.ts";
import { registerCommand } from "../registry.ts";
import {
  ctrl,
  later,
  render,
  row,
  rowText,
  seed,
  start,
  installEditorTestHooks,
} from "./editor-test-kit.tsx";
import { setLocale } from "../../../i18n/index.ts";

import { useKeybindingsStore } from "../keybindings-store.ts";
const store = () => useKeybindingsStore.getState();
vi.mock("../../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
installEditorTestHooks();

describe("shortcuts table", () => {
  it("shows the effective chord and a Default badge, and search narrows the rows", async () => {
    const { container } = await render();
    const palette = rowText(container, "palette.toggle");
    expect(palette).toContain("Open the command palette");
    expect(palette).toContain("Ctrl+K");
    expect(palette).toContain("Default");
    expect(rowText(container, "pane.close")).toContain("Not assigned");
    await typeInto(field(container, "Search shortcuts") as HTMLInputElement, "palette");
    expect(
      [...container.querySelectorAll("[data-command]")].map((el) => el.getAttribute("data-command")),
    ).toEqual(["palette.toggle"]);
    await typeInto(field(container, "Search shortcuts") as HTMLInputElement, "zzzz");
    expect(text(container)).toContain("No shortcut matches.");
  });

  it("has no listbox or menu role, which would count as an open overlay", async () => {
    const { container } = await render();
    expect(container.querySelector('[role="listbox"], [role="menu"]')).toBeNull();
  });

  it("speaks French", async () => {
    setLocale("fr");
    const { container } = await render();
    expect(rowText(container, "palette.toggle")).toContain("Par défaut");
    expect(rowText(container, "pane.close")).toContain("Non attribué");
  });

  it("warns about a user rule on a chord the browser keeps", async () => {
    seed([{ key: "mod+w", command: "tab.close" }]);
    const { container } = await render();
    expect(rowText(container, "tab.close")).toContain("Your browser may keep this shortcut.");
  });
});

describe("recorder", () => {
  it("turns Change into a pressed recorder and saves the chord with the default clause", async () => {
    const handler = vi.fn();
    later(registerCommand("palette.toggle", handler));
    later(
      installDispatcher({
        win: window,
        platform: "other",
        rules: () => store().rules,
        shell: () => ({ mobile: false, treeOpen: false }),
      }),
    );
    const { container } = await render();
    const recorder = await start(container, "palette.toggle");
    expect(recorder.getAttribute("aria-pressed")).toBe("true");
    expect(recorder.hasAttribute("data-shortcut-recorder")).toBe(true);
    expect(recorder.textContent).toBe("Press keys…");
    await press(recorder, ctrl("P", "KeyP", { shiftKey: true }));
    expect(store().user).toEqual([{ key: "mod+shift+p", command: "palette.toggle", when: "!panelFocus" }]);
    const after = rowText(container, "palette.toggle");
    expect(after).toContain("Custom");
    expect(after).toContain("Ctrl+Shift+P");
    expect(button(row(container, "palette.toggle"), "Change").getAttribute("aria-pressed")).toBe("false");
    // Ctrl+K inside the recorder is recorded, not run.
    const other = await start(container, "tab.close");
    await press(other, ctrl("k", "KeyK"));
    expect(handler).not.toHaveBeenCalled();
    expect(store().user.at(-1)).toEqual({
      key: "mod+k",
      command: "tab.close",
      when: "!panelFocus && !editableFocus && !dialogOpen",
    });
  });

  it("cancels on Escape without reaching session.stop, even inside a session pane", async () => {
    const stop = vi.fn();
    later(registerCommand("session.stop", stop));
    later(
      installDispatcher({
        win: window,
        platform: "other",
        rules: () => store().rules,
        shell: () => ({ mobile: false, treeOpen: false }),
      }),
    );
    const { container } = await render();
    // Control: Escape from another control of the session pane does stop the run.
    const outside = container.querySelector<HTMLElement>('[data-testid="outside"]');
    outside?.focus();
    await press(outside as HTMLElement, { key: "Escape", code: "Escape" });
    expect(stop).toHaveBeenCalledTimes(1);
    const recorder = await start(container, "palette.toggle");
    recorder.focus();
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    later(() => document.removeEventListener("keydown", seen));
    await press(recorder, { key: "Escape", code: "Escape" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled(); // the rest of the page never hears a key meant for the recorder
    expect(recorder.getAttribute("aria-pressed")).toBe("false");
    expect(store().user).toEqual([]);
  });

  it("refuses a key without a modifier, and a chord the browser keeps, and saves nothing", async () => {
    const { container } = await render();
    const recorder = await start(container, "palette.toggle");
    await press(recorder, { key: "q", code: "KeyQ" });
    expect(text(row(container, "palette.toggle"))).toContain("Include at least one modifier key.");
    expect(recorder.getAttribute("aria-pressed")).toBe("true");
    await press(recorder, ctrl("w", "KeyW"));
    expect(text(row(container, "palette.toggle"))).toContain(
      "Your browser keeps this shortcut. Choose another.",
    );
    expect(text(row(container, "palette.toggle"))).not.toContain("Include at least one modifier key.");
    expect(store().user).toEqual([]);
  });

  it("allows a bare key for the help command and a function key for any command", async () => {
    const { container } = await render();
    await press(await start(container, "shortcuts.help"), { key: "h", code: "KeyH" });
    await press(await start(container, "tab.close"), { key: "F5", code: "F5" });
    expect(store().user).toEqual([
      { key: "h", command: "shortcuts.help", when: "!panelFocus && !editableFocus && !dialogOpen" },
      { key: "f5", command: "tab.close", when: "!panelFocus && !editableFocus && !dialogOpen" },
    ]);
  });

  it("ignores a lone modifier, and stores a digit by its physical key", async () => {
    const { container } = await render();
    const recorder = await start(container, "palette.toggle");
    await press(recorder, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(recorder.getAttribute("aria-pressed")).toBe("true");
    await press(recorder, { key: "&", code: "Digit7", ctrlKey: true, shiftKey: true });
    expect(store().user).toEqual([{ key: "mod+shift+7", command: "palette.toggle", when: "!panelFocus" }]);
  });

  it("stops recording when the recorder loses focus", async () => {
    const { container } = await render();
    const recorder = await start(container, "palette.toggle");
    recorder.focus();
    await act(async () => recorder.blur());
    expect(recorder.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("conflicts, reset and remove", () => {
  it("warns on both rows when two commands share a chord, and still saves", async () => {
    const { container } = await render();
    await press(await start(container, "session.new"), ctrl(",", "Comma"));
    expect(store().user).toEqual([
      { key: "mod+,", command: "session.new", when: "!panelFocus && !dialogOpen" },
    ]);
    expect(rowText(container, "session.new")).toContain("Conflicts with Open settings");
    expect(rowText(container, "settings.open")).toContain("Conflicts with New session");
  });

  it("joins several conflicting titles with the locale's list format", async () => {
    seed([
      { key: "mod+,", command: "session.new", when: "!panelFocus && !dialogOpen" },
      { key: "mod+,", command: "pane.close", when: "!panelFocus && !dialogOpen" },
    ]);
    const { container } = await render();
    expect(rowText(container, "settings.open")).toContain("Conflicts with New session and Close the pane");
    setLocale("fr");
    await act(async () => {});
    expect(rowText(container, "settings.open")).toContain(
      "En conflit avec Nouvelle session et Fermer le volet",
    );
  });

  it("Reset gives the defaults back to one command, Remove leaves it unassigned", async () => {
    const { container } = await render();
    await press(await start(container, "palette.toggle"), ctrl("p", "KeyP"));
    expect(button(row(container, "palette.toggle"), "Reset")).toBeTruthy();
    await click(button(row(container, "palette.toggle"), "Reset"));
    expect(store().user).toEqual([]);
    expect(rowText(container, "palette.toggle")).toContain("Default");
    await click(button(row(container, "palette.toggle"), "Remove"));
    expect(store().user).toEqual([{ key: "none", command: "palette.toggle" }]);
    const removed = rowText(container, "palette.toggle");
    expect(removed).toContain("Not assigned");
    expect(removed).toContain("Custom");
    await click(button(row(container, "palette.toggle"), "Reset"));
    expect(store().user).toEqual([]);
  });

  it("Remove on a command without a default only drops the user rule", async () => {
    const { container } = await render();
    await press(await start(container, "pane.close"), ctrl("x", "KeyX"));
    expect(store().user).toHaveLength(1);
    await click(button(row(container, "pane.close"), "Remove"));
    expect(store().user).toEqual([]);
  });

  it("Reset all clears every user rule and Undo brings them back", async () => {
    const { container } = await render();
    await press(await start(container, "palette.toggle"), ctrl("p", "KeyP"));
    await press(await start(container, "tab.close"), ctrl("y", "KeyY"));
    const before = store().user;
    await click(button(container, "Reset all"));
    expect(store().user).toEqual([]);
    expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain("Shortcuts reset");
    await click(button(document.body, "Undo"));
    expect(store().user).toEqual(before);
  });

  it("says so when the account would hold more than 256 rules", async () => {
    seed(Array.from({ length: 256 }, (_, i) => ({ key: `alt+${i % 9}`, command: "tab.next" })));
    const { container } = await render();
    await press(await start(container, "palette.toggle"), ctrl("p", "KeyP"));
    expect(store().user).toHaveLength(256);
    expect(text(container)).toContain("Too many custom rules");
  });
});
