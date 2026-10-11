// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { button, click, field, hasButton, settle, typeInto } from "../../testing/dom.ts";
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

async function shown(path: string, options?: Parameters<typeof renderShell>[1]) {
  const page = await renderShell(path, options);
  await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
    timeout: 2_000,
  });
  return page;
}
const banner = () =>
  [...document.querySelectorAll('[data-slot="banner"]')].find(
    (el) => el.textContent?.includes("page seulement") || el.textContent?.includes("this page only"),
  ) ?? null;

describe("Language section", () => {
  it("switches the page language at once, without a reload, and stores it", async () => {
    const page = await shown("/settings/language");
    await click(button(page.container, "Français"));
    expect(document.documentElement.lang).toBe("fr");
    expect(localStorage.getItem("pap.locale")).toBe("fr");
    expect(
      document.querySelector('nav[aria-label="Sections des réglages"] a[aria-current="page"]')?.textContent,
    ).toBe("Langue");
    expect(banner()).toBeNull();
    await page.unmount();
  });

  it("says the choice applies to this page only when the browser refuses to store it", async () => {
    const page = await shown("/settings/language");
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await click(button(page.container, "Français"));
    expect(document.documentElement.lang).toBe("fr");
    expect(banner()?.getAttribute("role")).toBe("status");
    expect(banner()?.textContent).toBe(
      "Appliqué à cette page seulement : ce navigateur ne garde pas les réglages.",
    );
    await page.unmount();
  });

  it("shows no banner when English is stored", async () => {
    const page = await shown("/settings/language");
    expect(banner()).toBeNull();
    expect(localStorage.getItem("pap.locale")).toBeNull();
    await page.unmount();
  });
});

describe("Account & devices section", () => {
  it("shows the username and offers a passkey only when passkeys are available", async () => {
    const without = await shown("/settings/account");
    expect(without.container.textContent).toContain("Signed in as");
    expect(without.container.querySelector("[data-settings-screen] p .font-mono")?.textContent).toBe("ana");
    expect(hasButton(without.container, "Add a passkey")).toBe(false);
    await without.unmount();
    const withKeys = await shown("/settings/account", { passkeysAvailable: true });
    expect(hasButton(withKeys.container, "Add a passkey")).toBe(true);
    await withKeys.unmount();
  });

  it("says Passkey added in a status line after the password is accepted", async () => {
    const page = await shown("/settings/account", { passkeysAvailable: true });
    await click(button(page.container, "Add a passkey"));
    await typeInto(field(page.container, "Password"), "hunter2 hunter2");
    await click(page.container.querySelector('button[type="submit"]') as HTMLElement);
    await settle();
    expect(auth.registerPasskey).toHaveBeenCalledWith("hunter2 hunter2");
    const status = [...page.container.querySelectorAll('[role="status"]')].map((el) => el.textContent);
    expect(status).toContain("Passkey added.");
    await page.unmount();
  });

  it("signs out through logout then onSignedOut", async () => {
    const onSignedOut = vi.fn();
    const page = await shown("/settings/account", { onSignedOut });
    await click(button(page.container, "Sign out"));
    await settle();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
    await page.unmount();
  });

  it("keeps the session and shows the error toast when logout fails", async () => {
    auth.logout.mockRejectedValue(new Error("down"));
    const onSignedOut = vi.fn();
    const page = await shown("/settings/account", { onSignedOut });
    await click(button(page.container, "Sign out"));
    await settle();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sign-out did not reach pap. Try again.");
    expect(page.container.querySelector("[data-settings-screen]")).not.toBeNull();
    await page.unmount();
  });
});

describe("placeholder sections", () => {
  it("keeps Appearance and Keyboard shortcuts as one-line empty states until their tasks", async () => {
    const page = await shown("/settings/shortcuts");
    expect(page.container.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    await page.unmount();
  });
});
