// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, settle } from "../../testing/dom.ts";
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
beforeEach(() => {
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

  it("keeps the account bar until the top bar exists: sign-out calls logout then onSignedOut", async () => {
    const onSignedOut = vi.fn();
    const page = await renderShell("/", { username: "ana", onSignedOut });
    expect(page.container.textContent).toContain("pap · ana");
    await click(button(page.container, "Sign out"));
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("does not re-push the path when it already matches the active item", async () => {
    const page = await renderShell("/s/abc");
    const length = window.history.length;
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/abc");
    expect(window.history.length).toBe(length);
    await page.unmount();
  });
});
