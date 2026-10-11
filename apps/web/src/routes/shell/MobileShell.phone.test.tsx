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
import { click, mount, press, settle, typeInto } from "../../testing/dom.ts";
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
    const page = await renderShell("/s/one", { phone: true });
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
