// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, field, settle, typeInto } from "../../../testing/dom.ts";
import { render, seed, installEditorTestHooks } from "./editor-test-kit.tsx";

import { useKeybindingsStore } from "../keybindings-store.ts";
const store = () => useKeybindingsStore.getState();
vi.mock("../../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
installEditorTestHooks();

describe("JSON view", () => {
  const openJson = async (container: HTMLElement) => click(button(container, "Edit as JSON"));
  const json = (container: HTMLElement) =>
    field(container, "Keyboard shortcuts as JSON") as HTMLTextAreaElement;

  it("shows the user rules, applies the valid entries and lists the others by number", async () => {
    seed([{ key: "alt+p", command: "palette.toggle", when: "!dialogOpen" }]);
    const { container } = await render();
    await openJson(container);
    expect(JSON.parse(json(container).value)).toEqual([
      { key: "alt+p", command: "palette.toggle", when: "!dialogOpen" },
    ]);
    await typeInto(
      json(container),
      JSON.stringify([
        { key: "alt+o", command: "palette.toggle" },
        { key: "alt+q", command: "nope.nothing" },
        { key: "alt+z", command: "tab.close" },
      ]),
    );
    await click(button(container, "Apply"));
    expect(store().user).toEqual([
      { key: "alt+o", command: "palette.toggle" },
      { key: "alt+z", command: "tab.close" },
    ]);
    expect(container.querySelector('[data-slot="shortcuts-json-issues"]')?.textContent).toContain(
      "Entry 2: unknown command.",
    );
  });

  it("refuses text that is not a list, applying nothing", async () => {
    seed([{ key: "alt+p", command: "palette.toggle" }]);
    const { container } = await render();
    await openJson(container);
    await typeInto(json(container), "{oops");
    await click(button(container, "Apply"));
    expect(store().user).toEqual([{ key: "alt+p", command: "palette.toggle" }]);
    expect(container.querySelector('[data-slot="shortcuts-json-issues"]')?.textContent).toContain(
      "The text is not valid JSON.",
    );
  });

  it("renders what the file says as text only", async () => {
    const { container } = await render();
    await openJson(container);
    await typeInto(json(container), '[{"key":"<img src=x onerror=alert(1)>","command":"palette.toggle"}]');
    await click(button(container, "Apply"));
    const issues = container.querySelector('[data-slot="shortcuts-json-issues"]');
    expect(issues?.textContent).toContain("Entry 1: unknown key.");
    expect(issues?.querySelector("img")).toBeNull();
  });

  it("exports the user rules as a file, the URL revoked later", async () => {
    seed([{ key: "alt+p", command: "palette.toggle" }]);
    let blob: Blob | undefined;
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (value: Blob) => {
          blob = value;
          return "blob:pap/kb";
        },
        revokeObjectURL: revoke,
      }),
    );
    let name = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    vi.useFakeTimers();
    const { container } = await render();
    await openJson(container);
    await click(button(container, "Export"));
    expect(name).toBe("pap-keybindings.json");
    expect(await blob?.text()).toBe(
      `${JSON.stringify([{ key: "alt+p", command: "palette.toggle" }], null, 2)}\n`,
    );
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40_000);
    expect(revoke).toHaveBeenCalledWith("blob:pap/kb");
    vi.useRealTimers();
  });

  it("imports a file through the same path, and refuses a big one before reading it", async () => {
    const { container } = await render();
    await openJson(container);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const pick = async (file: unknown) => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => {
        input?.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
    };
    const textOf = vi.fn(async () => '[{"key":"alt+o","command":"palette.toggle"}]');
    await pick({ size: 60_000, text: textOf });
    expect(store().user).toEqual([{ key: "alt+o", command: "palette.toggle" }]);
    const hugeText = vi.fn(async () => "[]");
    await pick({ size: 70_000, text: hugeText });
    expect(hugeText).not.toHaveBeenCalled();
    expect(container.querySelector('[data-slot="shortcuts-json-issues"]')?.textContent).toContain(
      "The file is larger than 64 KB.",
    );
    expect(store().user).toEqual([{ key: "alt+o", command: "palette.toggle" }]);
  });
});

describe("save status", () => {
  it("follows the store", async () => {
    const { container } = await render();
    const line = () => container.querySelector('[data-slot="shortcuts-status"]')?.textContent;
    expect(line()).toBe("");
    for (const [status, expected] of [
      ["saving", "Saving…"],
      ["saved", "Saved to your account"],
      ["error", "Not saved to your account. Your next change tries again."],
    ] as const) {
      await act(async () => store().setStatus(status));
      expect(line()).toBe(expected);
    }
    await act(async () => store().setStatus("load-error"));
    expect(line()).toContain("could not be loaded");
  });
});
