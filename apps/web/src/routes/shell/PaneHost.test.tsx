// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { click, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useSessionsCache } from "./sessions-cache.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/workspace/use-element-width.ts", () => ({ useElementWidth: () => 1000 }));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionScreen: () => createElement("p", { "data-stub": "session" }) };
});

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
  useSessionsCache.setState({ sessions: [], status: "loaded" });
  useWorkspaceStore.setState({
    ws: {
      tabs: [
        {
          key: "session:a",
          item: { kind: "session", id: "a" },
          split: { item: { kind: "home" }, ratio: 0.4 },
        },
        { key: "home", item: { kind: "home" }, split: null },
        { key: "settings", item: { kind: "settings", section: "appearance" }, split: null },
      ],
      active: "session:a",
    },
  });
});

describe("PaneHost with a split", () => {
  it("shows both items around a labelled separator, and no menu until asked", async () => {
    const page = await renderShell("/s/a");
    await vi.waitFor(
      () => expect(page.container.querySelector('#pane-main [data-stub="session"]')).not.toBeNull(),
      { timeout: 2_000 },
    ); // the session screen is a lazy chunk
    expect(page.container.querySelector('[data-pane-role="split"] [data-stub="home"]')).not.toBeNull();
    const separator = page.container.querySelector('[role="separator"]') as HTMLElement;
    expect([separator.getAttribute("aria-label"), separator.getAttribute("aria-valuenow")]).toEqual([
      "Resize panes",
      "40",
    ]);
    expect(page.container.ownerDocument.querySelector('[role="menu"]')).toBeNull();
    await page.unmount();
  });

  it("changes the second item from its menu, and closes the split", async () => {
    const page = await renderShell("/s/a");
    await click(
      page.container.querySelector(
        '[data-pane-role="split"] [aria-label="Show in this pane"]',
      ) as HTMLElement,
    );
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
    expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual([
      "New session",
      "Settings",
    ]);
    await click(document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement);
    await settle();
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split).toEqual({
      item: { kind: "settings", section: "appearance" },
      ratio: 0.4,
    });
    await click(
      page.container.querySelector('[data-pane-role="split"] [aria-label="Close split"]') as HTMLElement,
    );
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split).toBeNull();
    await page.unmount();
  });
});
