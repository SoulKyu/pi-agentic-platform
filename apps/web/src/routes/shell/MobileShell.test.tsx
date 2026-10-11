// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { BottomNav } from "./BottomNav.tsx";
import { useSessionsCache } from "./sessions-cache.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement: h } = await import("react");
  return { SessionListScreen: () => h("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement: h } = await import("react");
  return {
    SessionScreen: ({ sessionId }: { sessionId: string }) => h("p", { "data-stub": "session" }, sessionId),
  };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["sessions.list"] = () => ({
    sessions: [{ id: "one", cwd: "/w/api", status: "idle", createdAt: 1, updatedAt: 1 }],
  });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({ sessions: [], status: "idle" });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  document.documentElement.removeAttribute("data-keyboard-open");
  vi.unstubAllGlobals();
});

const nav = (container: ParentNode) => container.querySelector<HTMLElement>('nav[aria-label="Sections"]');
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("phone shell", () => {
  it("shows a Sections nav with four tabs, Work current, and no rail", async () => {
    const page = await renderShell("/", { phone: true });
    const bar = nav(page.container);
    expect(bar?.getAttribute("data-slot")).toBe("bottom-nav");
    expect([...(bar?.querySelectorAll("button") ?? [])].map((one) => one.textContent)).toEqual([
      "Agents",
      "Work",
      "Lists",
      "Inbox",
    ]);
    expect(button(bar as HTMLElement, "Work").getAttribute("aria-current")).toBe("page");
    expect(button(bar as HTMLElement, "Agents").hasAttribute("aria-current")).toBe(false);
    expect(page.container.querySelector('[data-slot="rail"]')).toBeNull();
    expect(page.container.querySelector('[data-shell="mobile"]')).not.toBeNull();
    expect(page.container.querySelector('[data-pane-kind="home"] [data-stub="home"]')).not.toBeNull();
    await page.unmount();
  });

  it("keeps the desktop layout on a wide screen", async () => {
    const page = await renderShell("/", { phone: false });
    expect(page.container.querySelector('[data-shell="desktop"]')).not.toBeNull();
    expect(nav(page.container)).toBeNull();
    await page.unmount();
  });

  it("has a decorative Mark in the top bar: not a link, hidden from assistive tech", async () => {
    const page = await renderShell("/", { phone: true });
    const mark = page.container.querySelector('[data-slot="mark"]');
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.closest("a")).toBeNull();
    expect(mark?.getAttribute("width")).toBe("20");
    await page.unmount();
  });

  it("Agents says there is no agent yet, with no action", async () => {
    const page = await renderShell("/", { phone: true });
    await click(button(nav(page.container) as HTMLElement, "Agents"));
    expect(page.container.textContent).toContain("No agent yet");
    expect(page.container.textContent).toContain(
      "A long-term agent has its own thread, memory, budget and triggers.",
    );
    expect(button(nav(page.container) as HTMLElement, "Agents").getAttribute("aria-current")).toBe("page");
    expect(page.container.querySelector('[data-pane-kind="home"]')).toBeNull();
    await page.unmount();
  });

  it("Inbox says nothing waits", async () => {
    const page = await renderShell("/", { phone: true });
    await click(button(nav(page.container) as HTMLElement, "Inbox"));
    expect(page.container.textContent).toContain("Nothing waits for you");
    await page.unmount();
  });

  it("Lists shows the session tree; picking a session opens it and returns to Work", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    await click(button(nav(page.container) as HTMLElement, "Lists"));
    await settle();
    const row = page.container.querySelector<HTMLElement>('a[href="/s/one"]');
    expect(row).not.toBeNull();
    await click(row as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/one");
    expect(button(nav(page.container) as HTMLElement, "Work").getAttribute("aria-current")).toBe("page");
    expect(page.container.querySelector('[data-stub="session"]')?.textContent).toBe("one");
    await page.unmount();
  });

  it("any navigation, not only a pick, returns to Work", async () => {
    const page = await renderShell("/", { phone: true });
    await click(button(nav(page.container) as HTMLElement, "Inbox"));
    await act(() => page.router.navigate({ to: "/s/$sessionId", params: { sessionId: "two" } }));
    expect(button(nav(page.container) as HTMLElement, "Work").getAttribute("aria-current")).toBe("page");
    await page.unmount();
  });

  it("the tab switcher button opens a sheet listing the open items; choosing one opens it and closes the sheet", async () => {
    const page = await renderShell("/s/one", { phone: true });
    await act(() => page.router.navigate({ to: "/s/$sessionId", params: { sessionId: "two" } }));
    expect(sheet()).toBeNull();
    await click(page.container.querySelector('button[aria-label="Open items"]') as HTMLElement);
    await vi.waitFor(() => expect(sheet()?.querySelector("h2")?.textContent).toBe("Open items"), {
      timeout: 2_000,
    });
    const rows = [...(sheet()?.querySelectorAll("li") ?? [])].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    const first = sheet()?.querySelector("li button") as HTMLElement;
    await click(first);
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/one");
    await vi.waitFor(() => expect(sheet()).toBeNull(), { timeout: 2_000 });
    await page.unmount();
  });

  it("the search button runs the palette", async () => {
    const page = await renderShell("/", { phone: true });
    await click(page.container.querySelector('button[aria-label="Search and commands"]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    await page.unmount();
  });

  it("keeps no menu or listbox in the page, so Escape stays reachable for session.stop", async () => {
    const page = await renderShell("/", { phone: true });
    expect(page.container.querySelector('[role="menu"], [role="listbox"]')).toBeNull();
    await page.unmount();
  });

  it("hides the bottom nav while the keyboard is open", () => {
    const css = readFileSync(join(import.meta.dirname, "../../styles.css"), "utf8");
    expect(css).toMatch(/html\[data-keyboard-open\] \[data-slot="bottom-nav"\]\s*\{\s*display:\s*none;/);
  });
});

describe("BottomNav", () => {
  it("shows no badge at zero and reports the tab that was pressed", async () => {
    const picked: string[] = [];
    const page = await mount(
      createElement(BottomNav, { section: "work", inboxCount: 0, onSection: (one) => picked.push(one) }),
    );
    expect(page.container.querySelector('[data-slot="badge"]')).toBeNull();
    await click(button(page.container, "Lists"));
    expect(picked).toEqual(["lists"]);
    await page.unmount();
  });
});
