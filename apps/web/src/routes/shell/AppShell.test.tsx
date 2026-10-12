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
const defaultRules = useKeybindingsStore.getState().rules;
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  useKeybindingsStore.setState({ rules: defaultRules });
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
    await vi.waitFor(
      () => expect(page.container.querySelector('[data-stub="session"]')?.textContent).toBe("abc"),
      { timeout: 2_000 },
    ); // the session screen is a lazy chunk
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

  it("renders a settings section inside its pane once the chunk has loaded", async () => {
    const page = await renderShell("/settings/shortcuts");
    await vi.waitFor(
      () =>
        expect(page.container.querySelector('[data-pane-kind="settings"] h1')?.textContent).toBe(
          "Keyboard shortcuts",
        ),
      { timeout: 2_000 },
    );
    await page.unmount();
  });

  it("says it is reconnecting, and offers a reload when the page is out of date", async () => {
    const page = await renderShell("/");
    await act(async () => bed.fake.setState("waiting"));
    expect(
      [...page.container.querySelectorAll('[role="status"]')].some((el) =>
        el.textContent?.startsWith("Reconnecting…"),
      ),
    ).toBe(true);
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
    const panel = page.container.querySelector('[data-pane-kind="session"]') as HTMLElement;
    expect(
      page.container.ownerDocument.getElementById(panel.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("pi-agentic"); // the pane is named by its tab
    await page.unmount();
  });

  it("the rail opens Settings, and its account menu signs out", async () => {
    const onSignedOut = vi.fn();
    const page = await renderShell("/", { onSignedOut });
    await click(page.container.querySelector('[aria-label="Settings"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/appearance");
    expect(page.container.ownerDocument.querySelector('[role="menu"]')).toBeNull(); // not in the DOM until asked for
    await click(page.container.querySelector('[aria-label="Account"]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
    expect(rows).toEqual(["ana", "Sign out"]);
    await press(document.activeElement as HTMLElement, { key: "ArrowDown" });
    await settle();
    await press(document.activeElement as HTMLElement, { key: "Enter" });
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("shows no empty account row without a username", async () => {
    const page = await renderShell("/", { username: null });
    await click(page.container.querySelector('[aria-label="Account"]') as HTMLElement);
    await vi.waitFor(
      () =>
        expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual([
          "Sign out",
        ]),
      { timeout: 2000 },
    );
    await page.unmount();
  });

  it("falls back to an icon on the palette button while its chord is not loaded", async () => {
    useKeybindingsStore.setState({ rules: [] });
    const page = await renderShell("/");
    const palette = page.container.querySelector('[aria-label="Search and commands"]') as HTMLElement;
    expect([palette.querySelector("kbd"), palette.querySelector("svg") !== null]).toEqual([null, true]);
    await page.unmount();
  });

  it("refreshes the list once for a session id it does not have, never in a loop", async () => {
    let answers = 0;
    bed.handlers["sessions.list"] = () => ({
      sessions:
        ++answers < 2
          ? []
          : [{ id: "abc", cwd: "/home/ana/fresh", status: "idle", createdAt: 1, updatedAt: 2 }],
    });
    const page = await renderShell("/s/abc");
    await act(async () => bed.fake.setState("open"));
    await settle();
    await settle();
    expect(bed.called("sessions.list")).toHaveLength(2);
    expect(page.container.querySelector("header")?.textContent).toContain("fresh");
    await page.unmount();
  });

  it("asks only once for an id that stays missing", async () => {
    let calls = 0;
    bed.handlers["sessions.list"] = () => (++calls > 5 ? new Promise(() => {}) : { sessions: [] });
    const page = await renderShell("/s/ghost");
    await act(async () => bed.fake.setState("open"));
    await settle();
    await settle();
    await settle();
    expect(calls).toBe(2); // the refresh on open, then one for the missing id
    await page.unmount();
  });

  it("listens for shortcuts only while mounted, and follows the effective bindings", async () => {
    // A command and bindings of its own, cloned from product rules, so no product task's command is borrowed.
    const rule = (from: string) => {
      const found = useKeybindingsStore.getState().rules.find((candidate) => candidate.command === from);
      if (!found) throw new Error(`no default rule for ${from}`);
      return { ...found, command: "test.only" };
    };
    const first = rule("palette.toggle");
    const second = rule("settings.open");
    const probe = vi.fn();
    const off = registerCommand("test.only", probe);
    useKeybindingsStore.setState({ rules: [first] });
    const page = await renderShell("/");
    await press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
    expect(probe).toHaveBeenCalledOnce();
    useKeybindingsStore.setState({ rules: [second] });
    await press(document.body, { key: ",", code: "Comma", ctrlKey: true });
    expect(probe).toHaveBeenCalledTimes(2);
    await press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
    expect(probe).toHaveBeenCalledTimes(2);
    await page.unmount();
    await press(document.body, { key: ",", code: "Comma", ctrlKey: true });
    expect(probe).toHaveBeenCalledTimes(2);
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
