// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, mount, press, settle, typeInto } from "../../testing/dom.ts";
import { terminalView } from "../../testing/m8-fixtures.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { BottomNav } from "./BottomNav.tsx";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useShellStore } from "../../stores/shell-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement: h } = await import("react");
  return { SessionListScreen: () => h("p", { "data-stub": "home" }) };
});
// xterm needs a real browser; the pane's own tests drive the surface through a stub.
vi.mock("@pap/ui/terminal", async () => {
  const { createElement: h } = await import("react");
  return { TerminalSurface: () => h("div", { "data-stub": "terminal-surface" }) };
});
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement: h } = await import("react");
  return {
    SessionScreen: ({ sessionId }: { sessionId: string }) => h("p", { "data-stub": "session" }, sessionId),
  };
});

/** The terminal feed starts when its lazy chunk has loaded: deliver once the sub is open. */
const emitTerminal = (bed: ReturnType<typeof fakeRuntime>, event: unknown) =>
  vi.waitFor(() => bed.emitTo("subscribe.terminal", event), { timeout: 2_000 });

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  // The phone tests drive the layout, not the feed: the snapshot is applied to the store they read from.
  useShellStore.getState().apply(shellSnapshot([shellSession({ id: "one", cwd: "/w/api" })]));
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  vi.unstubAllGlobals();
});

const css = () =>
  readFileSync(join(import.meta.dirname, "../../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = document.documentElement;
const options = () => [...document.querySelectorAll('[role="option"]')].map((one) => one.textContent);

describe("phone access to settings and sign-out", () => {
  it("the top bar search button is a 44 px target that opens the palette, which lists Open settings and Sign out", async () => {
    const page = await renderShell("/", { phone: true });
    await settle();
    const search = page.container.querySelector<HTMLElement>('button[aria-label="Search and commands"]');
    expect(search?.className).toContain("pointer-coarse:min-h-11");
    expect(search?.className).toContain("pointer-coarse:min-w-11");
    await click(search as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    await settle();
    const field = document.querySelector("input") as HTMLInputElement;
    await typeInto(field, "Sign out");
    expect(options()).toContain("Sign out");
    await typeInto(field, "Open settings");
    expect(options().some((row) => row?.startsWith("Open settings"))).toBe(true);
    await press(field, { key: "Enter" });
    await settle();
    await settle();
    expect(page.router.state.location.pathname).toMatch(/^\/settings/);
    await page.unmount();
  });
});

describe("the toast lift", () => {
  it("sets data-shell=mobile on <html> while MobileShell is mounted, so the sibling Toaster can read it", async () => {
    const phone = await renderShell("/", { phone: true });
    expect(html.getAttribute("data-shell")).toBe("mobile");
    await phone.unmount();
    expect(html.hasAttribute("data-shell")).toBe(false);
    const desktop = await renderShell("/", { phone: false });
    expect(html.hasAttribute("data-shell")).toBe(false);
    await desktop.unmount();
  });

  it("declares the offset on <html> and consumes it with a fallback, only under the phone or keyboard attribute", () => {
    const text = css();
    expect(text).toMatch(/html\[data-shell="mobile"\]\s*\{[^}]*--toast-bottom:/);
    expect(text).toMatch(
      /html\[data-shell="mobile"\] \[data-slot="toast-viewport"\]\s*\{\s*bottom:\s*var\(--toast-bottom,\s*[^)]+\);/,
    );
    expect(text).toMatch(
      /html\[data-keyboard-open\] \[data-slot="toast-viewport"\]\s*\{[^}]*var\(--app-viewport-height/,
    );
    // Without the attribute nothing overrides the primitive's own `max-md:bottom-s2`.
    const selectors = [...text.matchAll(/([^{}]*toast-viewport[^{}]*)\{/g)].map(
      (one) => one[1]?.trim() ?? "",
    );
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors)
      expect(selector).toMatch(/^html\[data-(shell="mobile"|keyboard-open)\]/);
    const primitive = readFileSync(
      join(import.meta.dirname, "../../../../../packages/ui/src/primitives/Toast.tsx"),
      "utf8",
    );
    expect(primitive).toContain("max-md:bottom-s2");
  });

  it("ties the nav height and the toast offset to one custom property", () => {
    const text = css();
    expect(text.match(/--bottom-nav-height:/g)).toHaveLength(1);
    expect(text).toMatch(/\[data-slot="bottom-nav"\]\s*\{[^}]*var\(--bottom-nav-height\)/);
    expect(text).toMatch(/--toast-bottom:[^;]*var\(--bottom-nav-height\)/);
    expect(text).not.toContain("2.75rem");
  });
});

/** What a screen reader says: the text outside aria-hidden, in order, with spaces normalised. */
function accessibleText(element: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return;
    if (node.nodeType === 3) parts.push(node.textContent ?? "");
    node.childNodes.forEach(walk);
  };
  walk(element);
  return parts.join("").replace(/\s+/g, " ").trim();
}

describe("the Inbox count", () => {
  const inboxName = async (count: number) => {
    const page = await mount(
      createElement(BottomNav, { section: "work", inboxCount: count, onSection: () => {} }),
    );
    const name = accessibleText(page.container.querySelectorAll("button")[3] as Element);
    await page.unmount();
    return name;
  };

  it("is announced with its number in English at 0, 1 and 2", async () => {
    expect(await inboxName(0)).toBe("Inbox");
    expect(await inboxName(1)).toBe("Inbox 1 unread");
    expect(await inboxName(2)).toBe("Inbox 2 unread");
  });

  it("follows the French plural rule", async () => {
    setLocale("fr");
    expect(await inboxName(0)).toBe("Boîte");
    expect(await inboxName(1)).toBe("Boîte 1 non lu");
    expect(await inboxName(2)).toBe("Boîte 2 non lus");
  });
});

describe("phone and desktop", () => {
  it("keeps the tabs, the active item and an open palette when the width crosses 768 px", async () => {
    let phone = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query === "(max-width: 767.98px)" ? phone : false;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    const page = await renderShell("/s/one");
    await act(() => page.router.navigate({ to: "/s/$sessionId", params: { sessionId: "two" } }));
    await click(page.container.querySelector('button[aria-label="Search and commands"]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    const tabs = useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key);
    expect(tabs).toEqual(["session:one", "session:two"]);

    for (const [onPhone, shell] of [
      [false, "desktop"],
      [true, "mobile"],
    ] as const) {
      phone = onPhone;
      await act(async () => listeners.forEach((listener) => listener()));
      expect(page.container.querySelector(`[data-shell="${shell}"]`), shell).not.toBeNull();
      expect(useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key)).toEqual(tabs);
      expect(useWorkspaceStore.getState().ws.active).toBe("session:two");
      expect(page.router.state.location.pathname).toBe("/s/two");
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    }
    await page.unmount();
  });
});

describe("the tab sheet", () => {
  it("says there is no open item instead of showing an empty list", async () => {
    // At a path that names no item, so the shell does not reopen one when the workspace empties.
    useWorkspaceStore.setState({
      ws: {
        tabs: [{ key: "session:one", item: { kind: "session", id: "one" }, split: null }],
        active: "session:one",
      },
    });
    const page = await renderShell("/nope", { phone: true });
    await click(page.container.querySelector('button[aria-label="Open items"]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(document.querySelectorAll('[role="dialog"] li')).toHaveLength(1);
    await act(async () => useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE }));
    expect(document.querySelectorAll('[role="dialog"] li')).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("No open item");
    await page.unmount();
  });
});

describe("the Chat / Review / Term switch (M8R72)", () => {
  let bed: ReturnType<typeof fakeRuntime>;
  const switchOf = (page: { container: HTMLElement }) =>
    page.container.querySelector<HTMLElement>('[data-slot="surface-switch"]') as HTMLElement;
  const shown = (page: { container: HTMLElement }) =>
    page.container.querySelector("#pane-main")?.getAttribute("data-pane-kind");
  const selected = (page: { container: HTMLElement }) =>
    [...switchOf(page).querySelectorAll("button")]
      .filter((one) => one.getAttribute("aria-current") === "true")
      .map((one) => one.textContent);

  beforeEach(() => {
    bed = fakeRuntime("open");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    current.runtime = bed.runtime;
    useTerminalStore.getState().reset();
    useShellStore.getState().apply(
      shellSnapshot([shellSession({ id: "one", cwd: "/w/api/src", projectId: "p" })], {
        projects: [shellProject({ id: "p", root: "/w/api" })],
      }),
    );
    useWorkspaceStore.setState({
      ws: {
        tabs: [{ key: "session:one", item: { kind: "session", id: "one" }, split: null }],
        active: "session:one",
      },
    });
  });

  it("shows on a session tab with Chat selected and the session screen, and not on a settings tab", async () => {
    const page = await renderShell("/s/one", { phone: true });
    expect([...switchOf(page).querySelectorAll("button")].map((one) => one.textContent)).toEqual([
      "Chat",
      "Review",
      "Term",
    ]);
    expect(selected(page)).toEqual(["Chat"]);
    await vi.waitFor(() => expect(page.container.querySelector('[data-stub="session"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(page.container.querySelector("[data-pane-role]")).toBeNull();
    await page.unmount();
    const settings = await renderShell("/settings/appearance", { phone: true });
    expect(settings.container.querySelector('[data-slot="surface-switch"]')).toBeNull();
    await settings.unmount();
  });

  it("Review renders only the changes pane, and Chat returns to the session", async () => {
    const page = await renderShell("/s/one", { phone: true });
    await click(button(switchOf(page), "Review"));
    await vi.waitFor(() => expect(page.container.querySelector("[data-changes-pane]")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(shown(page)).toBe("changes");
    expect(page.container.querySelector('[data-stub="session"]')).toBeNull();
    expect(selected(page)).toEqual(["Review"]);
    await click(button(switchOf(page), "Chat"));
    await vi.waitFor(() => expect(page.container.querySelector('[data-stub="session"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(page.container.querySelector("[data-changes-pane]")).toBeNull();
    expect(selected(page)).toEqual(["Chat"]);
    await page.unmount();
  });

  it("Term with no tagged terminal creates exactly one and shows the terminal pane", async () => {
    const page = await renderShell("/s/one", { phone: true });
    await settle();
    await emitTerminal(bed, { kind: "snapshot", terminals: [] });
    await settle();
    bed.handlers["terminal.create"] = () => ({ terminalId: terminalView(5).id });
    await click(button(switchOf(page), "Term"));
    await vi.waitFor(() => expect(page.container.querySelector("[data-terminal-pane]")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(bed.called("terminal.create")).toHaveLength(1);
    expect(shown(page)).toBe("terminal");
    expect(selected(page)).toEqual(["Term"]);
    await page.unmount();
  });

  it("Term uses the tagged terminal that exists, and each tab starts on Chat", async () => {
    useWorkspaceStore.setState({
      ws: {
        tabs: [
          { key: "session:one", item: { kind: "session", id: "one" }, split: null },
          { key: "session:two", item: { kind: "session", id: "two" }, split: null },
        ],
        active: "session:one",
      },
    });
    const page = await renderShell("/s/one", { phone: true });
    await settle();
    await emitTerminal(bed, {
      kind: "snapshot",
      terminals: [terminalView(1, { sessionId: "one" })],
    });
    await settle();
    await click(button(switchOf(page), "Term"));
    await vi.waitFor(() => expect(shown(page)).toBe("terminal"), { timeout: 2_000 });
    expect(bed.called("terminal.create")).toHaveLength(0);
    await act(() => page.router.navigate({ to: "/s/$sessionId", params: { sessionId: "two" } }));
    expect(selected(page)).toEqual(["Chat"]);
    await page.unmount();
  });

  it("shows Files as the selected item when the files pane is what the tab shows", async () => {
    useWorkspaceStore.setState({
      ws: {
        tabs: [
          {
            key: "session:one",
            item: { kind: "session", id: "one" },
            split: { item: { kind: "files", root: "/w/api" }, ratio: 0.5 },
          },
        ],
        active: "session:one",
      },
    });
    const page = await renderShell("/s/one", { phone: true });
    await click(button(switchOf(page), "Chat"));
    expect(selected(page)).toEqual(["Chat"]);
    const { useSurfaceView } = await import("./surface-view.ts");
    await act(async () => useSurfaceView.getState().show("session:one", "files"));
    await vi.waitFor(() => expect(page.container.querySelector("[data-files-pane]")).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(selected(page)).toEqual(["Files"]);
    await page.unmount();
  });

  it("disables Review and Term for a session the store does not hold", async () => {
    useShellStore.getState().reset();
    const page = await renderShell("/s/one", { phone: true });
    expect([...switchOf(page).querySelectorAll("button")].map((one) => one.disabled)).toEqual([
      false,
      true,
      true,
    ]);
    await page.unmount();
  });
});
