// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { registerCommand, startKeybindings, useKeybindingsStore } from "../../features/commands/index.ts";
import { useSessionsCache } from "./sessions-cache.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  logout: auth.logout,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return {
    SessionScreen: ({ sessionId }: { sessionId: string }) =>
      createElement("p", { "data-stub": "session" }, sessionId),
  };
});

let bed: ReturnType<typeof fakeRuntime>;
let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  useSessionsCache.setState({ sessions: [], status: "idle" });
  bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
});

describe("AppShell", () => {
  it("renders the home item in a pane and opens its tab", async () => {
    const page = await renderShell("/");
    expect(page.container.querySelector('[data-pane-kind="home"] [data-stub="home"]')).not.toBeNull();
    expect(useWorkspaceStore.getState().ws.active).toBe("home");
    await page.unmount();
  });

  it("opens a session from its URL", async () => {
    const page = await renderShell("/s/abc");
    expect(page.container.querySelector('[data-stub="session"]')?.textContent).toBe("abc");
    expect(useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key)).toEqual(["session:abc"]);
    await page.unmount();
  });

  it("unknown path shows not found without opening a tab", async () => {
    const page = await renderShell("/nope");
    expect(page.container.querySelector("h2")?.textContent).toBe("This page does not exist");
    expect(useWorkspaceStore.getState().ws.tabs).toEqual([]);
    await click(button(page.container, "Go to the start"));
    await settle();
    expect(page.container.querySelector('[data-stub="home"]')).not.toBeNull();
    await page.unmount();
  });

  it("an invalid session id is not found, not home, and opens no tab", async () => {
    const page = await renderShell("/s/..");
    expect(page.container.querySelector("h2")?.textContent).toBe("This page does not exist");
    expect(page.router.state.location.pathname).toBe("/s/..");
    expect(useWorkspaceStore.getState().ws.tabs).toEqual([]);
    await page.unmount();
  });

  it("/dev/ui outside dev builds is the not-found screen", async () => {
    vi.stubEnv("DEV", false);
    try {
      const page = await renderShell("/dev/ui");
      expect(page.container.querySelector("h2")?.textContent).toBe("This page does not exist");
      expect(page.container.querySelector("[data-pane-kind]")).toBeNull();
      expect(useWorkspaceStore.getState().ws.tabs).toEqual([]);
      await page.unmount();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("settings has no screen yet and shows not found inside its pane", async () => {
    const page = await renderShell("/settings/shortcuts");
    expect(page.container.querySelector('[data-pane-kind="settings"] h2')?.textContent).toBe(
      "This page does not exist",
    );
    await page.unmount();
  });

  it("says it is reconnecting, and offers a reload when the page is out of date", async () => {
    const page = await renderShell("/");
    await act(async () => bed.fake.setState("waiting"));
    expect([...page.container.querySelectorAll('[role="status"]')].map((el) => el.textContent)).toContain(
      "Reconnecting…",
    );
    await act(async () => bed.fake.setState("outdated"));
    expect(hasButton(page.container, "Reload")).toBe(true);
    await page.unmount();
  });

  it("renders no banner while the connection is fine", async () => {
    const page = await renderShell("/");
    await act(async () => bed.fake.setState("open"));
    expect(page.container.querySelector('[data-slot="banner"]')).toBeNull();
    await page.unmount();
  });

  it("loads the account settings and the session list each time the socket opens", async () => {
    const page = await renderShell("/");
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(bed.called("settings.get").map((call) => call.params)).toEqual([
      { key: "appearance" },
      { key: "keybindings" },
    ]);
    expect(bed.called("sessions.list")).toHaveLength(1);
    await act(async () => bed.fake.setState("waiting"));
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(bed.called("sessions.list")).toHaveLength(2);
    await page.unmount();
  });

  it("titles the top bar with the active item: a session by its folder", async () => {
    bed.handlers["sessions.list"] = () => ({
      sessions: [{ id: "abc", cwd: "/home/ana/pi-agentic", status: "idle", createdAt: 1, updatedAt: 2 }],
    });
    const page = await renderShell("/s/abc");
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(page.container.querySelector("header")?.textContent).toContain("pi-agentic");
    expect(page.container.querySelector('[data-pane-kind="session"]')?.getAttribute("aria-label")).toBe(
      "pi-agentic",
    );
    await page.unmount();
  });

  it("the rail opens Settings, and its account menu signs out", async () => {
    const onSignedOut = vi.fn();
    const page = await renderShell("/", { onSignedOut });
    await click(page.container.querySelector('[aria-label="Settings"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/appearance");
    // Radix menus open from the keyboard in happy-dom (they listen for pointerdown, not click).
    await press(page.container.querySelector('[aria-label="Account"]') as HTMLElement, { key: "Enter" });
    await settle();
    await press(document.activeElement as HTMLElement, { key: "Enter" });
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("listens for shortcuts only while mounted, and follows the effective bindings", async () => {
    const tree = vi.fn();
    const off = registerCommand("drawer.tree.toggle", tree);
    const page = await renderShell("/");
    await press(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(tree).toHaveBeenCalledOnce();
    useKeybindingsStore.getState().setUser([{ key: "mod+j", command: "drawer.tree.toggle" }]);
    await press(document.body, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(tree).toHaveBeenCalledTimes(2);
    await page.unmount();
    await press(document.body, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(tree).toHaveBeenCalledTimes(2);
    off();
  });

  it("does not re-push the path when it already matches the active item", async () => {
    const page = await renderShell("/s/abc");
    const length = page.router.history.length;
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/abc");
    expect(page.router.history.length).toBe(length);
    await page.unmount();
  });
});
