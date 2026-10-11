// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { click, settle } from "../../testing/dom.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useSessionsCache } from "../shell/sessions-cache.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
const auth = vi.hoisted(() => ({ logout: vi.fn(), registerPasskey: vi.fn() }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  logout: auth.logout,
  registerPasskey: auth.registerPasskey,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({ sessions: [], status: "idle" });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  auth.logout.mockReset().mockResolvedValue(undefined);
  auth.registerPasskey.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  setLocale("en");
  document.documentElement.lang = "en";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const screen = () => document.querySelector("[data-settings-screen]");
async function shown(path: string, options?: Parameters<typeof renderShell>[1]) {
  const page = await renderShell(path, options);
  await vi.waitFor(() => expect(screen()).not.toBeNull(), { timeout: 2_000 });
  return page;
}

describe("SettingsScreen", () => {
  it("lists the personal sections in a labelled nav and marks the current one", async () => {
    const page = await shown("/settings/language");
    const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual([
      "Appearance",
      "Keyboard shortcuts",
      "Language",
      "Account & devices",
    ]);
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, null, "page", null]);
    expect(page.container.querySelector("h1")?.textContent).toBe("Language");
    await page.unmount();
  });

  it("moves between sections inside the one settings tab", async () => {
    const page = await shown("/settings/language");
    const account = [...document.querySelectorAll('nav[aria-label="Settings sections"] a')].find(
      (link) => link.textContent === "Account & devices",
    ) as HTMLElement;
    await click(account);
    await settle();
    expect(page.router.state.location.pathname).toBe("/settings/account");
    expect(page.container.querySelector("h1")?.textContent).toBe("Account & devices");
    expect(useWorkspaceStore.getState().ws.tabs.filter((tab) => tab.item.kind === "settings")).toHaveLength(
      1,
    );
    await page.unmount();
  });

  it("replaces the list with a Section select on a phone, and its listbox exists only while open", async () => {
    const page = await shown("/settings/language", { phone: true });
    expect(document.querySelector('nav[aria-label="Settings sections"]')).toBeNull();
    const trigger = document.querySelector('[role="combobox"]') as HTMLElement;
    expect(trigger.getAttribute("aria-labelledby")).not.toBeNull();
    expect(document.getElementById(trigger.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "Section",
    );
    expect(trigger.textContent).toContain("Language");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await page.unmount();
  });
});
