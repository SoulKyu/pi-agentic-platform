// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { registerCommand, startKeybindings, useKeybindingsStore } from "../../features/commands/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { RpcError } from "../../runtime/rpc.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

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
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return {
    SessionScreen: ({ sessionId }: { sessionId: string }) =>
      createElement("p", { "data-stub": "session" }, sessionId),
  };
});

/** The rail and the rows open menus: their chunk loads before the page mounts. */
const withMenu = (path: string, options: Parameters<typeof renderShell>[1] = {}) =>
  renderShell(path, { chunks: ["menu"], ...options });

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
  useShellStore.getState().reset();
  bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
});

describe("AppShell", () => {
  it("renders the home item in a pane and opens its tab", async () => {
    const page = await withMenu("/");
    expect(page.container.querySelector('[data-pane-kind="home"] [data-stub="home"]')).not.toBeNull();
    expect(useWorkspaceStore.getState().ws.active).toBe("home");
    await page.unmount();
  });

  it("opens a session from its URL", async () => {
    const page = await withMenu("/s/abc");
    await vi.waitFor(
      () => expect(page.container.querySelector('[data-stub="session"]')?.textContent).toBe("abc"),
      { timeout: 2_000 },
    ); // the session screen is a lazy chunk
    expect(useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key)).toEqual(["session:abc"]);
    await page.unmount();
  });

  it("unknown path shows not found without opening a tab", async () => {
    const page = await withMenu("/nope");
    expect(page.container.querySelector("h2")?.textContent).toBe("This page does not exist");
    expect(useWorkspaceStore.getState().ws.tabs).toEqual([]);
    await click(button(page.container, "Go to the start"));
    await settle();
    expect(page.container.querySelector('[data-stub="home"]')).not.toBeNull();
    await page.unmount();
  });

  it("an invalid session id is not found, not home, and opens no tab", async () => {
    const page = await withMenu("/s/..");
    expect(page.container.querySelector("h2")?.textContent).toBe("This page does not exist");
    expect(page.router.state.location.pathname).toBe("/s/..");
    expect(useWorkspaceStore.getState().ws.tabs).toEqual([]);
    await page.unmount();
  });

  it("/dev/ui outside dev builds is the not-found screen", async () => {
    vi.stubEnv("DEV", false);
    try {
      const page = await withMenu("/dev/ui");
      expect(page.container.querySelector("h2")?.textContent).toBe("This page does not exist");
      expect(page.container.querySelector("[data-pane-kind]")).toBeNull();
      expect(useWorkspaceStore.getState().ws.tabs).toEqual([]);
      await page.unmount();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("renders a settings section inside its pane once the chunk has loaded", async () => {
    const page = await withMenu("/settings/shortcuts");
    await vi.waitFor(
      () =>
        expect(page.container.querySelector('[data-pane-kind="settings"] h1')?.textContent).toBe(
          "Keyboard shortcuts",
        ),
      { timeout: 2_000 },
    );
    await page.unmount();
  });

  it("says the daemon is not answering, and offers a reload when the page is out of date", async () => {
    const page = await withMenu("/");
    await act(async () => bed.fake.setState("waiting"));
    expect(
      [...page.container.querySelectorAll('[role="status"]')].some((el) =>
        el.textContent?.startsWith("The daemon is not answering."),
      ),
    ).toBe(true);
    await act(async () => bed.fake.setState("outdated"));
    expect(hasButton(page.container, "Reload")).toBe(true);
    await page.unmount();
  });

  it("renders no banner while the connection is fine", async () => {
    const page = await withMenu("/");
    await act(async () => bed.fake.setState("open"));
    expect(page.container.querySelector('[data-slot="banner"]')).toBeNull();
    await page.unmount();
  });

  it("loads the account settings each time the socket opens", async () => {
    const page = await withMenu("/");
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(bed.called("settings.get").map((call) => call.params)).toEqual([
      { key: "appearance" },
      { key: "keybindings" },
    ]);
    await act(async () => bed.fake.setState("waiting"));
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(bed.called("settings.get")).toHaveLength(4);
    await page.unmount();
  });

  it("subscribes to the shell and lane streams once while mounted and never lists sessions", async () => {
    const page = await withMenu("/");
    await act(async () => bed.fake.setState("open"));
    await settle();
    expect(bed.called("subscribe.shell")).toHaveLength(1);
    expect(bed.called("subscribe.lane")).toHaveLength(1);
    expect(bed.called("subscribe.launches")).toHaveLength(1);
    expect(bed.called("subscribe.previews")).toHaveLength(1);
    expect(bed.called("sessions.list")).toEqual([]);
    await page.unmount();
    await settle();
    // The shell, lane (M9R3), Inbox (M10R50), agents (M11R63), launches (launch progress) and previews (UX-2) streams.
    expect(bed.called("unsubscribe")).toHaveLength(6);
  });

  it("a refused shell subscription sets the store's failed and reports shell_feed_failed once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      bed.handlers["subscribe.shell"] = () => {
        throw new RpcError("capacity");
      };
      const page = await withMenu("/");
      await act(async () => bed.fake.setState("open"));
      await settle();
      expect(useShellStore.getState().view.failed).toBe("capacity");
      expect(warn.mock.calls.filter(([line]) => line === "pap: shell_feed_failed")).toHaveLength(1);
      await page.unmount();
      expect(useShellStore.getState().view.failed).toBeNull(); // unmount resets the store
    } finally {
      warn.mockRestore();
    }
  });

  it("forgets the labels of the session views on unmount, so the next account's tabs never carry old names", async () => {
    const page = await withMenu("/");
    useViewLabels.getState().put("a", { name: "Previous account", cwd: "/x/y" });
    expect(useViewLabels.getState().labels).toEqual({ a: { name: "Previous account", cwd: "/x/y" } });
    await page.unmount();
    expect(useViewLabels.getState().labels).toEqual({});
  });

  it("names a session once, in its tab: the top bar carries the pap wordmark, not the title again", async () => {
    const page = await withMenu("/s/abc");
    await act(async () => bed.fake.setState("open"));
    await settle();
    await act(async () =>
      bed.emitTo(
        "subscribe.shell",
        shellSnapshot([shellSession({ id: "abc", cwd: "/home/ana/pi-agentic", name: "Fix tests" })]),
      ),
    );
    const bar = page.container.querySelector("header") as HTMLElement;
    expect(bar.querySelector('[data-slot="wordmark"]')?.textContent).toBe("pap");
    // The small 13 px name of board 06, not the 20 px one of the auth frame; the symbol stays in the rail.
    expect(bar.querySelector('[data-slot="wordmark"] span')?.className).toContain("text-ui");
    expect(bar.querySelector('[data-slot="wordmark"] span')?.className).not.toContain("text-h1");
    expect(bar.textContent).not.toContain("Fix tests");
    const tabs = page.container.querySelector('[role="tablist"]') as HTMLElement;
    expect(tabs.textContent).toContain("Fix tests");
    expect(tabs.parentElement?.className).toContain("bg-bg");
    expect(tabs.parentElement?.className).not.toContain("bg-bg-side");
    const panel = page.container.querySelector('[data-pane-kind="session"]') as HTMLElement;
    expect(
      page.container.ownerDocument.getElementById(panel.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("Fix tests"); // the pane is named by its tab
    await page.unmount();
  });

  it("the rail opens Settings, and its account menu signs out", async () => {
    const onSignedOut = vi.fn();
    const page = await withMenu("/", { onSignedOut });
    await click(page.container.querySelector('[aria-label="Settings"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/appearance");
    expect(page.container.ownerDocument.querySelector('[role="menu"]')).toBeNull(); // not in the DOM until asked for
    await click(page.container.querySelector('[aria-label="Account"]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
    expect(rows).toEqual(["ana", "Keyboard shortcuts", "Sign out"]);
    await press(document.activeElement as HTMLElement, { key: "ArrowDown" });
    await settle();
    await press(document.activeElement as HTMLElement, { key: "ArrowDown" });
    await settle();
    await press(document.activeElement as HTMLElement, { key: "Enter" });
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("the rail's Tasks button opens the Tasks board (§5)", async () => {
    const page = await withMenu("/");
    await click(page.container.querySelector('[aria-label="Tasks"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/tasks");
    await page.unmount();
  });

  it("the account menu opens the keyboard shortcuts (§5)", async () => {
    const page = await withMenu("/");
    await click(page.container.querySelector('[aria-label="Account"]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull(), { timeout: 2000 });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (row) => row.textContent === "Keyboard shortcuts",
    );
    await click(item as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector("[data-command]")).not.toBeNull(), {
      timeout: 2000,
    });
    await page.unmount();
  });

  it("shows no empty account row without a username", async () => {
    const page = await withMenu("/", { username: null });
    await click(page.container.querySelector('[aria-label="Account"]') as HTMLElement);
    await vi.waitFor(
      () =>
        expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual([
          "Keyboard shortcuts",
          "Sign out",
        ]),
      { timeout: 2000 },
    );
    await page.unmount();
  });

  it("falls back to an icon on the palette button while its chord is not loaded", async () => {
    useKeybindingsStore.setState({ rules: [] });
    const page = await withMenu("/");
    const palette = page.container.querySelector('[aria-label="Search and commands"]') as HTMLElement;
    expect([palette.querySelector("kbd"), palette.querySelector("svg") !== null]).toEqual([null, true]);
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
    const page = await withMenu("/");
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
    const page = await withMenu("/s/abc");
    const length = page.router.history.length;
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/abc");
    expect(page.router.history.length).toBe(length);
    await page.unmount();
  });
});
