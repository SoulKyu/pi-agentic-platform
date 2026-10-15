// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, press, settle, typeInto } from "../../testing/dom.ts";
import { tasksSnapshot } from "../../testing/home-fixtures.ts";
import { chip, composer, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomeBody.tsx", () => ({ default: () => null }));
// The tooltip loads Radix on hover: the hint it would show is read from the props instead.
vi.mock("@pap/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pap/ui")>()),
  Tooltip: (props: {
    label: string;
    shortcut?: readonly string[];
    shortcutJoiner?: string;
    children: ReactElement;
  }) =>
    createElement(
      "span",
      { "data-tip": `${props.label} ${(props.shortcut ?? []).join(props.shortcutJoiner ?? "")}` },
      props.children,
    ),
}));

let bed: ReturnType<typeof fakeRuntime>;
// The project facts and the launch are lazy chunks: its first transform is paid here, not inside a test.
beforeAll(async () => {
  await import("./ProjectFacts.tsx");
  await import("./run-launch.ts");
});
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  resetHome();
});
afterEach(() => vi.unstubAllGlobals());

const reasonOf = (node: HTMLElement) =>
  document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent;

describe("ProjectHome: the modes (§3.1, §7)", () => {
  it("are a radiogroup moved by arrow keys, and the last one chosen is remembered for this device", async () => {
    const first = await showHome();
    const radios = () =>
      [...document.querySelectorAll('[role="radio"]')].map((node) => [
        node.textContent,
        node.getAttribute("aria-checked"),
      ]);
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Launch mode");
    expect(radios()).toEqual([
      ["Session", "true"],
      ["Lane", "false"],
      ["Fan-out", "false"],
      ["Trigger", "false"],
    ]);
    await press(chip("Session"), { key: "ArrowRight" });
    expect(chip("Lane").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(chip("Lane"));
    await press(chip("Lane"), { key: "End" });
    expect(chip("Trigger").getAttribute("aria-checked")).toBe("true");
    await press(chip("Trigger"), { key: "ArrowRight" });
    expect(chip("Session").getAttribute("aria-checked")).toBe("true");
    await click(chip("Fan-out"));
    expect(localStorage.getItem("pap.home.mode.v1")).toBe("fanout");
    await first.page.unmount();
    const again = await showHome();
    expect(chip("Fan-out").getAttribute("aria-checked")).toBe("true");
    expect(button(again.page.container, "Launch a fan-out")).toBeDefined();
  });

  it("shows New lane's chord as the Lane chip's hint (§3.2)", async () => {
    await showHome();
    expect(chip("Lane").closest("[data-tip]")?.getAttribute("data-tip")).toBe("New lane Ctrl+Shift+L");
  });

  it("Lane opens the dialog with the first line as title and the rest as description; Fan-out with two slots", async () => {
    const { page, actions } = await showHome();
    await click(chip("Lane"));
    await typeInto(composer(), "Replace the cache\nKeep the API");
    await click(button(page.container, "Launch a lane"));
    await settle();
    expect(actions.newLane).toHaveBeenLastCalledWith({
      projectRoot: "/w/api",
      title: "Replace the cache",
      text: "Keep the API",
      models: [null],
    });
    await click(chip("Fan-out"));
    await click(button(page.container, "Launch a fan-out"));
    await settle();
    expect(actions.newLane).toHaveBeenLastCalledWith({
      projectRoot: "/w/api",
      title: "Replace the cache",
      text: "Keep the API",
      models: [null, null],
    });
  });

  it("Trigger opens the project's new trigger with the first line as name and the text as prompt", async () => {
    const { page, actions } = await showHome();
    await click(chip("Trigger"));
    await typeInto(composer(), "Nightly report\nSummarise the failures");
    await click(button(page.container, "Launch a trigger"));
    await settle();
    expect(actions.newTrigger).toHaveBeenCalledExactlyOnceWith("p1", {
      name: "Nightly report",
      prompt: "Nightly report\nSummarise the failures",
    });
  });

  it("an empty launch opens each dialog empty", async () => {
    const { page, actions } = await showHome();
    await click(chip("Lane"));
    await click(button(page.container, "Launch a lane"));
    await settle();
    await click(chip("Fan-out"));
    await click(button(page.container, "Launch a fan-out"));
    await settle();
    await click(chip("Trigger"));
    await click(button(page.container, "Launch a trigger"));
    await settle();
    expect(actions.newLane.mock.calls).toEqual([
      [{ projectRoot: "/w/api", title: "", text: "", models: [null] }],
      [{ projectRoot: "/w/api", title: "", text: "", models: [null, null] }],
    ]);
    expect(actions.newTrigger).toHaveBeenCalledExactlyOnceWith("p1", { name: "", prompt: "" });
  });

  it("opens a dialog with the focus in the composer, so a dialog that closes without launching gives it back (§7)", async () => {
    const { page, actions } = await showHome();
    let focused: Element | null = null;
    actions.newLane.mockImplementation(() => {
      focused = document.activeElement;
      return true;
    });
    await click(chip("Lane"));
    await click(button(page.container, "Launch a lane"));
    await settle();
    expect(focused).toBe(composer());
  });

  it("Enter launches, Shift+Enter is a new line, Ctrl+Enter launches too", async () => {
    const { actions } = await showHome();
    await click(chip("Lane"));
    await typeInto(composer(), "Fix");
    expect((await press(composer(), { key: "Enter", shiftKey: true })).defaultPrevented).toBe(false);
    expect(actions.newLane).not.toHaveBeenCalled();
    expect((await press(composer(), { key: "Enter" })).defaultPrevented).toBe(true);
    await settle();
    expect(actions.newLane).toHaveBeenCalledTimes(1);
    await press(composer(), { key: "Enter", ctrlKey: true });
    await settle();
    expect(actions.newLane).toHaveBeenCalledTimes(2);
  });

  it("an input method's Enter never launches; a phone's Enter is a new line (Review Focus 3)", async () => {
    const first = await showHome();
    await click(chip("Lane"));
    await typeInto(composer(), "Fix");
    expect((await press(composer(), { key: "Enter", isComposing: true })).defaultPrevented).toBe(false);
    expect(first.actions.newLane).not.toHaveBeenCalled();
    await first.page.unmount();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const phone = await showHome();
    await typeInto(composer(), "Fix");
    expect((await press(composer(), { key: "Enter" })).defaultPrevented).toBe(false);
    expect(phone.actions.newLane).not.toHaveBeenCalled();
    await click(button(phone.page.container, "Launch a lane"));
    await settle();
    expect(phone.actions.newLane).toHaveBeenCalledTimes(1);
  });

  it("disables Lane and Fan-out with their reason in a folder that is not a git repository (§3.2, §7)", async () => {
    bed.handlers["lanes.preview"] = () => ({ repo: false });
    await showHome();
    await settle();
    expect(bed.called("lanes.preview")[0]?.params).toEqual({ projectRoot: "/w/api" });
    for (const label of ["Lane", "Fan-out"]) {
      expect(chip(label).getAttribute("aria-disabled")).toBe("true");
      expect(reasonOf(chip(label))).toBe("Lane and Fan-out: not a git repository.");
    }
    await click(chip("Lane"));
    expect(chip("Session").getAttribute("aria-checked")).toBe("true");
  });

  it("falls back to Session for a remembered Lane in such a folder, and keeps the choice for other projects (PH14)", async () => {
    localStorage.setItem("pap.home.mode.v1", "lane");
    bed.handlers["lanes.preview"] = () => ({ repo: false });
    const { page } = await showHome();
    await settle();
    expect(button(page.container, "Launch a session")).toBeDefined();
    expect(localStorage.getItem("pap.home.mode.v1")).toBe("lane");
  });

  it("disables Trigger while automation is paused, or with a $0 daily budget", async () => {
    useTasksStore.getState().apply(tasksSnapshot([], { paused: true }));
    await showHome();
    expect(chip("Trigger").getAttribute("aria-disabled")).toBe("true");
    expect(reasonOf(chip("Trigger"))).toBe("Trigger: automation is paused.");
    await act(async () => useTasksStore.getState().apply(tasksSnapshot([], { budgetUsd: 0 })));
    expect(reasonOf(chip("Trigger"))).toBe("Trigger: the daily budget is $0, so no trigger can run.");
  });
});
