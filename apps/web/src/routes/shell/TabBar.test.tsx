// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { runCommand, startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore, type Tab } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { click, press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useSessionsCache } from "./sessions-cache.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionScreen: () => createElement("p", { "data-stub": "session" }) };
});

const tab = (key: string, item: Tab["item"]): Tab => ({ key, item, split: null });
const session: Tab = tab("session:a", { kind: "session", id: "a" });
const home: Tab = tab("home", { kind: "home" });

let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({
    sessions: [{ id: "a", cwd: "/home/ana/a", status: "running", createdAt: 1, updatedAt: 2 }],
    status: "loaded",
  });
  useWorkspaceStore.setState({ ws: { tabs: [session, home], active: "session:a" } });
});

const tabs = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
const named = (root: ParentNode, label: string) =>
  root.querySelector(`[aria-label="${label}"]`) as HTMLElement;

describe("TabBar", () => {
  it("is a labelled tablist with the active item selected and roving focus", async () => {
    useWorkspaceStore.setState({
      ws: {
        tabs: [session, home, tab("settings", { kind: "settings", section: "appearance" })],
        active: "session:a",
      },
    });
    const page = await renderShell("/s/a");
    const list = page.container.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute("aria-label")).toBe("Open items");
    expect(tabs(list).map((one) => [one.textContent, one.getAttribute("aria-selected")])).toEqual([
      ["a", "true"],
      ["New session", "false"],
      ["Settings", "false"],
    ]);
    expect(tabs(list).map((one) => one.id)).toEqual(["tab-session:a", "tab-home", "tab-settings"]);
    expect(page.container.querySelector("#pane-main")?.getAttribute("aria-labelledby")).toBe("tab-session:a");
    expect(page.container.querySelector("[data-slot=open-tab] span[aria-hidden]")).not.toBeNull(); // running dot
    const focusAfter = async (from: number, key: string) => {
      await press(tabs(list)[from] as HTMLElement, { key });
      return tabs(list).indexOf(document.activeElement as HTMLElement);
    };
    expect(await focusAfter(0, "ArrowRight")).toBe(1);
    expect(await focusAfter(2, "ArrowRight")).toBe(0); // wraps
    expect(await focusAfter(0, "ArrowLeft")).toBe(2); // wraps
    expect(await focusAfter(1, "End")).toBe(2);
    expect(await focusAfter(2, "Home")).toBe(0);
    await page.unmount();
  });

  it("selects by navigating, and closes by moving to the neighbour", async () => {
    const page = await renderShell("/s/a");
    await click(tabs(page.container)[1] as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    await click(tabs(page.container)[0] as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/a");
    await click(named(page.container, "Close a"));
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    expect(useWorkspaceStore.getState().ws.tabs.map((one) => one.key)).toEqual(["home"]);
    await page.unmount();
  });

  it("closing an inactive tab keeps the URL", async () => {
    const page = await renderShell("/s/a");
    const length = page.router.history.length;
    await click(named(page.container, "Close New session"));
    await settle();
    expect(page.router.history.length).toBe(length);
    expect(page.router.state.location.pathname).toBe("/s/a");
    expect(useWorkspaceStore.getState().ws.tabs.map((one) => one.key)).toEqual(["session:a"]);
    await page.unmount();
  });

  it("moves focus to the new active tab after the active one closes: button, Delete and tab.close", async () => {
    const page = await renderShell("/s/a");
    await click(named(page.container, "Close a"));
    await settle();
    expect(document.activeElement?.id).toBe("tab-home");

    useWorkspaceStore.setState({ ws: { tabs: [session, home], active: "session:a" } });
    await settle();
    await press(tabs(page.container)[0] as HTMLElement, { key: "Delete" });
    await settle();
    expect(document.activeElement?.id).toBe("tab-home");

    useWorkspaceStore.setState({ ws: { tabs: [session, home], active: "session:a" } });
    await settle();
    expect(runCommand("tab.close")).toBe(true);
    await settle();
    expect(document.activeElement?.id).toBe("tab-home");
    await page.unmount();
  });

  it("focuses New tab when the last tab closes, and leaves focus alone when an inactive tab closes", async () => {
    useWorkspaceStore.setState({ ws: { tabs: [session], active: "session:a" } });
    const page = await renderShell("/s/a");
    await click(named(page.container, "Close a"));
    await settle();
    expect(document.activeElement).toBe(named(page.container, "New tab"));
    useWorkspaceStore.setState({ ws: { tabs: [session, home], active: "session:a" } });
    await settle();
    named(page.container, "Split pane").focus();
    await click(named(page.container, "Close New session"));
    await settle();
    expect(document.activeElement).not.toBe(named(page.container, "New tab"));
    await page.unmount();
  });

  it("splits a lone non-home item with the start screen", async () => {
    useWorkspaceStore.setState({ ws: { tabs: [session], active: "session:a" } });
    const page = await renderShell("/s/a");
    await click(named(page.container, "Split pane"));
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split?.item).toEqual({ kind: "home" });
    await page.unmount();
  });

  it("opens the start screen from New tab", async () => {
    const page = await renderShell("/s/a");
    await click(named(page.container, "New tab"));
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    await page.unmount();
  });

  it("splits with the most recent other item, and the button then closes the split", async () => {
    const page = await renderShell("/s/a");
    await click(named(page.container, "Split pane"));
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split).toEqual({ item: { kind: "home" }, ratio: 0.5 });
    expect(named(page.container, "Split pane")).toBeNull();
    await click(named(page.container, "Close split"));
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split).toBeNull();
    await page.unmount();
  });

  it("has nothing to split with when the start screen is the only item", async () => {
    useWorkspaceStore.setState({ ws: { tabs: [home], active: "home" } });
    const page = await renderShell("/");
    expect((named(page.container, "Split pane") as HTMLButtonElement).disabled).toBe(true);
    await page.unmount();
  });

  it("answers the tab and split commands while mounted", async () => {
    const page = await renderShell("/s/a");
    expect(runCommand("tab.next")).toBe(true);
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    expect(runCommand("tab.prev")).toBe(true);
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/a");
    expect(runCommand("pane.split")).toBe(true);
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split?.item).toEqual({ kind: "home" });
    expect(runCommand("pane.split")).toBe(true); // toggles
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split).toBeNull();
    expect(runCommand("tab.close")).toBe(true);
    await settle();
    expect(page.router.state.location.pathname).toBe("/");
    await page.unmount();
    expect(runCommand("tab.next")).toBe(false);
  });

  it("renders no tabs for an empty workspace", async () => {
    useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
    const page = await renderShell("/nope");
    expect(tabs(page.container)).toEqual([]);
    expect(page.container.querySelector('[role="tablist"]')).not.toBeNull();
    await page.unmount();
  });
});
