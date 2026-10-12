// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore, type Tab } from "../../features/workspace/index.ts";
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
// A pap update removed the overlays chunk: the dynamic import rejects.
vi.mock("@pap/ui/overlays", () => {
  throw new Error("Failed to fetch dynamically imported module: overlays-1a2b3c.js");
});

const tab = (key: string, item: Tab["item"], split: Tab["split"] = null): Tab => ({ key, item, split });
const RELOAD_COPY = "This part of pap did not load. pap may have been updated: reload the page.";

let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.restoreAllMocks();
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({ sessions: [], status: "idle" });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const named = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const reloadOffered = () => [...document.querySelectorAll("button")].some((b) => b.textContent === "Reload");

describe("the overlay menus when the overlays chunk is gone (I3 of the final review)", () => {
  it("the account menu leaves the rail standing, says to reload, and offers the trigger again", async () => {
    const page = await renderShell("/");
    named("Account").focus();
    await click(named("Account"));
    await vi.waitFor(() => expect(document.body.textContent).toContain(RELOAD_COPY), { timeout: 2_000 });
    await settle();
    expect(page.container.querySelector('[data-slot="rail"]')).not.toBeNull();
    expect(page.container.querySelector('[data-shell="desktop"]')).not.toBeNull();
    expect(reloadOffered()).toBe(true);
    expect(named("Account")).not.toBeNull(); // the plain trigger is back
    expect(document.activeElement).toBe(named("Account")); // keyboard focus did not fall to the page
    await page.unmount();
  });

  it("Show in this pane leaves the panes standing and says to reload", async () => {
    const home = tab("home", { kind: "home" });
    useWorkspaceStore.setState({
      ws: {
        tabs: [{ ...home, split: { item: { kind: "settings", section: "appearance" }, ratio: 0.5 } }],
        active: "home",
      },
    });
    const page = await renderShell("/");
    await click(named("Show in this pane"));
    await vi.waitFor(() => expect(document.body.textContent).toContain(RELOAD_COPY), { timeout: 2_000 });
    await settle();
    expect(page.container.querySelector('[data-slot="rail"]')).not.toBeNull();
    expect(page.container.querySelector('[data-pane-role="split"]')).not.toBeNull();
    expect(reloadOffered()).toBe(true);
    await page.unmount();
  });
});
